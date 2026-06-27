// ==UserScript==
// @name         Bili Overdrive 强制倍速
// @name:en      Bili Overdrive - Force Playback Speed
// @namespace    https://github.com/ChrAlpha/bili-overdrive
// @version      1.0.0
// @description  强制手动控制 Bilibili 播放倍速，未登录也能用。浮动面板 + 快捷键，记忆上次倍速。
// @description:en  Force manual playback-speed control on Bilibili even when logged out. Floating panel + keyboard shortcuts, remembers last speed.
// @author       ChrAlpha
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/festival/*
// @run-at       document-start
// @noframes
// @grant        GM_setValue
// @grant        GM_getValue
// @license      MIT
// @homepageURL  https://github.com/ChrAlpha/bili-overdrive
// ==/UserScript==

(function () {
  'use strict';

  // Only run in the top frame; the player lives in the main document on
  // www.bilibili.com. @noframes covers this too, but be defensive.
  if (window.top !== window.self) return;

  /* ------------------------------------------------------------------ *
   * Config — tweak these freely.                                        *
   * ------------------------------------------------------------------ */
  const CONFIG = {
    presets: [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5],
    step: 0.25,      // keyboard fine step
    min: 0.25,
    max: 16,
    keys: {
      faster: ']',   // BracketRight
      slower: '[',   // BracketLeft
      reset: '\\',   // Backslash -> 1x
    },
    storeNs: 'biliOverdrive',
  };

  /* ------------------------------------------------------------------ *
   * Storage — GM_setValue/GM_getValue with a localStorage fallback.     *
   * ------------------------------------------------------------------ */
  const store = {
    get(key, def) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(CONFIG.storeNs + '.' + key);
          return v === undefined ? def : v;
        }
      } catch (e) { /* ignore */ }
      try {
        const raw = localStorage.getItem(CONFIG.storeNs + '.' + key);
        return raw == null ? def : JSON.parse(raw);
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(CONFIG.storeNs + '.' + key, val);
          return;
        }
      } catch (e) { /* ignore */ }
      try {
        localStorage.setItem(CONFIG.storeNs + '.' + key, JSON.stringify(val));
      } catch (e) { /* ignore */ }
    },
  };

  /* ------------------------------------------------------------------ *
   * Pure helpers.                                                       *
   * ------------------------------------------------------------------ */
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n) => Math.min(CONFIG.max, Math.max(CONFIG.min, round2(n)));
  const formatRate = (r) => (+r.toFixed(2)).toString() + '×'; // e.g. 1.25×

  /* ------------------------------------------------------------------ *
   * State.                                                              *
   * ------------------------------------------------------------------ */
  let desiredRate = clamp(Number(store.get('rate', 1)) || 1);

  // Patch the page's real prototype (not the userscript sandbox's view).
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Guard against a second instance in the same page realm (e.g. installed
  // twice). The flag lives on the shared page window so it is visible across
  // separate sandbox instances; bail before adding listeners/intervals/UI.
  try {
    if (win.__biliOverdriveInit) return;
    win.__biliOverdriveInit = true;
  } catch (e) { /* some managers restrict unsafeWindow writes — proceed */ }

  /* ------------------------------------------------------------------ *
   * Rate lock — the "force". Redefine HTMLMediaElement#playbackRate so   *
   * Bilibili's logged-out reset to 1x cannot stick.                     *
   * ------------------------------------------------------------------ */
  const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
  if (!proto) return;

  const desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
  // If we cannot find native accessors (very old engine), bail out of the
  // lock but still allow the rest (it would be a no-op anyway).
  const nativeGet = desc && desc.get;
  const nativeSet = desc && desc.set;

  // Read/write the *real* rate, bypassing our own property override.
  const readRate = (el) => {
    try { return nativeGet ? nativeGet.call(el) : el.playbackRate; }
    catch (e) { return 1; }
  };
  const writeRate = (el, r) => {
    try { if (nativeSet) nativeSet.call(el, r); }
    catch (e) { /* ignore */ }
  };

  function applyToAllMedia(rate) {
    const list = document.querySelectorAll('video, audio');
    for (let i = 0; i < list.length; i++) writeRate(list[i], rate);
  }

  if (nativeGet && nativeSet && !proto.__biliOverdrivePatched) {
    proto.__biliOverdrivePatched = true;
    Object.defineProperty(proto, 'playbackRate', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return nativeGet.call(this);
      },
      set(v) {
        v = Number(v);
        if (!isFinite(v) || v <= 0) return; // ignore garbage writes
        // Bilibili's logged-out reset forces 1x. Block it and re-assert ours.
        if (v === 1 && desiredRate !== 1) {
          nativeSet.call(this, desiredRate);
          return;
        }
        // Any other external write (a genuine 1x, or a logged-in native-menu
        // pick) is honored AND adopted so the UI stays in sync. Adopt the new
        // rate BEFORE writing it, so the ratechange backstop — which can fire
        // synchronously on the write — never reverts a freshly-honored value.
        const c = clamp(v);
        if (c !== desiredRate) {
          desiredRate = c;
          store.set('rate', desiredRate);
          scheduleUiUpdate();
        }
        nativeSet.call(this, c);
      },
    });
  }

  // Backstop guard: if anything bypasses the property and the rate drifts
  // away from what we want, snap it back.
  document.addEventListener('ratechange', (e) => {
    const el = e.target;
    if (!el || (el.nodeName !== 'VIDEO' && el.nodeName !== 'AUDIO')) return;
    if (readRate(el) !== desiredRate) writeRate(el, desiredRate);
  }, true);

  // Push our rate onto media as soon as it becomes usable.
  ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing'].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      const el = e.target;
      if (!el || (el.nodeName !== 'VIDEO' && el.nodeName !== 'AUDIO')) return;
      if (readRate(el) !== desiredRate) writeRate(el, desiredRate);
    }, true);
  });

  /* ------------------------------------------------------------------ *
   * Source of truth for user-initiated changes. Bypasses the property   *
   * override so a "reset to 1x" from our own UI is never blocked.        *
   * ------------------------------------------------------------------ */
  function setDesiredRate(rate, opts) {
    desiredRate = clamp(rate);
    store.set('rate', desiredRate);
    applyToAllMedia(desiredRate);
    scheduleUiUpdate();
    if (opts && opts.toast) showToast(formatRate(desiredRate));
  }
  const stepRate = (delta, opts) => setDesiredRate(desiredRate + delta, opts);

  /* ------------------------------------------------------------------ *
   * UI — built inside a Shadow DOM so Bilibili's CSS cannot reach in.    *
   * ------------------------------------------------------------------ */
  let shadow = null;
  let host = null;
  let panelEl = null;
  let rateEl = null;
  let presetEls = [];
  let toastEl = null;
  let toastTimer = null;
  let uiRaf = 0;

  function scheduleUiUpdate() {
    if (uiRaf) return;
    // Coalesce UI refreshes onto a macrotask. Deliberately use the sandbox's
    // setTimeout (not the page's requestAnimationFrame) to avoid any
    // illegal-invocation / cross-context pitfalls when called detached.
    uiRaf = setTimeout(() => {
      uiRaf = 0;
      updateUi();
    }, 0);
  }

  function updateUi() {
    if (rateEl) rateEl.textContent = formatRate(desiredRate);
    for (const el of presetEls) {
      const active = Math.abs(parseFloat(el.dataset.r) - desiredRate) < 1e-6;
      el.classList.toggle('active', active);
    }
  }

  function buildUi() {
    if (host && document.documentElement.contains(host)) return;
    if (!document.documentElement) return;

    host = document.createElement('div');
    host.id = 'bili-overdrive-host';
    // Zero-size anchor; children are independently fixed-positioned.
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;';
    shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
        .panel {
          position: fixed; right: 24px; bottom: 140px; pointer-events: auto;
          display: flex; flex-direction: column; gap: 6px;
          padding: 8px; border-radius: 12px;
          background: rgba(24, 26, 33, 0.92); color: #f1f2f6;
          box-shadow: 0 6px 24px rgba(0,0,0,0.45); backdrop-filter: blur(6px);
          user-select: none; font-size: 13px; line-height: 1;
          border: 1px solid rgba(255,255,255,0.08);
        }
        .bar { display: flex; align-items: center; gap: 6px; }
        .rate {
          min-width: 56px; text-align: center; cursor: move;
          font-weight: 700; font-size: 15px; padding: 4px 6px;
          color: #00a1d6; letter-spacing: .5px;
        }
        .btn {
          all: unset; cursor: pointer; text-align: center;
          min-width: 28px; height: 26px; line-height: 26px; padding: 0 8px;
          border-radius: 7px; background: rgba(255,255,255,0.08);
          color: #f1f2f6; font-size: 14px; transition: background .12s;
        }
        .btn:hover { background: rgba(255,255,255,0.18); }
        .btn.reset { font-size: 12px; min-width: 34px; }
        .btn.toggle { min-width: 26px; padding: 0; opacity: .8; }
        .presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
        .presets.hidden { display: none; }
        .preset {
          all: unset; cursor: pointer; text-align: center;
          height: 24px; line-height: 24px; border-radius: 6px;
          background: rgba(255,255,255,0.06); color: #cfd3dc; font-size: 12px;
          transition: background .12s, color .12s;
        }
        .preset:hover { background: rgba(255,255,255,0.16); color: #fff; }
        .preset.active { background: #00a1d6; color: #fff; font-weight: 700; }
        .btn:focus-visible, .preset:focus-visible { outline: 2px solid #00a1d6; outline-offset: 1px; }
        .toast {
          position: fixed; left: 50%; top: 14%; transform: translateX(-50%);
          pointer-events: none; padding: 8px 18px; border-radius: 10px;
          background: rgba(0,0,0,0.78); color: #fff; font-size: 22px; font-weight: 700;
          opacity: 0; transition: opacity .18s; letter-spacing: 1px;
        }
        .toast.show { opacity: 1; }
      </style>
      <div class="panel">
        <div class="bar">
          <button class="btn dec" title="减速 [ ">−</button>
          <span class="rate" title="拖动可移动 · 当前倍速">1×</span>
          <button class="btn inc" title="加速 ] ">+</button>
          <button class="btn reset" title="恢复 1× ( \\ )">1×</button>
          <button class="btn toggle" title="折叠/展开">⋯</button>
        </div>
        <div class="presets"></div>
      </div>
      <div class="toast"></div>
    `;

    const panel = shadow.querySelector('.panel');
    panelEl = panel;
    const presetsWrap = shadow.querySelector('.presets');
    rateEl = shadow.querySelector('.rate');
    toastEl = shadow.querySelector('.toast');

    shadow.querySelector('.dec').addEventListener('click', () => stepRate(-CONFIG.step));
    shadow.querySelector('.inc').addEventListener('click', () => stepRate(+CONFIG.step));
    shadow.querySelector('.reset').addEventListener('click', () => setDesiredRate(1));
    shadow.querySelector('.toggle').addEventListener('click', () => {
      const hidden = presetsWrap.classList.toggle('hidden');
      store.set('collapsed', hidden);
    });
    if (store.get('collapsed', false)) presetsWrap.classList.add('hidden');

    presetEls = CONFIG.presets.map((r) => {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.r = String(r);
      b.textContent = String(r);
      b.addEventListener('click', () => setDesiredRate(r));
      presetsWrap.appendChild(b);
      return b;
    });

    restorePanelPosition(panel);
    enableDrag(panel, rateEl);

    document.documentElement.appendChild(host);
    clampPanel();    // keep a restored position within the current viewport
    relocateHost();  // if we're already in fullscreen, mount into that subtree
    updateUi();
  }

  function restorePanelPosition(panel) {
    const pos = store.get('pos', null);
    if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
      panel.style.left = pos.left + 'px';
      panel.style.top = pos.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }

  // Keep a left/top-positioned panel inside the viewport (e.g. after the window
  // shrinks or fullscreen exits) so the drag handle never ends up off-screen.
  function clampPanel() {
    if (!panelEl) return;
    if (!panelEl.style.left && !panelEl.style.top) return; // still anchored bottom/right
    const maxL = Math.max(0, win.innerWidth - panelEl.offsetWidth);
    const maxT = Math.max(0, win.innerHeight - panelEl.offsetHeight);
    const left = Math.min(maxL, Math.max(0, parseFloat(panelEl.style.left) || 0));
    const top = Math.min(maxT, Math.max(0, parseFloat(panelEl.style.top) || 0));
    panelEl.style.left = left + 'px';
    panelEl.style.top = top + 'px';
  }

  // Native fullscreen promotes the player container to the browser top layer,
  // where only its descendants paint. Re-parent our shadow host into the
  // fullscreen element so the panel + toast stay visible; move it back on exit.
  function relocateHost() {
    if (!host) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    const parent = fs || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function enableDrag(panel, handle) {
    let dragging = false, startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      const rect = panel.getBoundingClientRect();
      baseLeft = rect.left; baseTop = rect.top;
      startX = e.clientX; startY = e.clientY;
      panel.style.left = baseLeft + 'px';
      panel.style.top = baseTop + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const maxL = Math.max(0, win.innerWidth - panel.offsetWidth);
      const maxT = Math.max(0, win.innerHeight - panel.offsetHeight);
      const left = Math.min(maxL, Math.max(0, baseLeft + (e.clientX - startX)));
      const top = Math.min(maxT, Math.max(0, baseTop + (e.clientY - startY)));
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      store.set('pos', {
        left: parseFloat(panel.style.left) || 0,
        top: parseFloat(panel.style.top) || 0,
      });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 700);
  }

  /* ------------------------------------------------------------------ *
   * Keyboard shortcuts.                                                 *
   * ------------------------------------------------------------------ */
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.nodeName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  // Resolve the focused node, piercing open shadow roots — Bilibili's comment
  // editor lives inside a <bili-comments> shadow root, so a document-level
  // listener would otherwise only see the retargeted host, not the real input.
  function deepActiveElement() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    const source = (path && path.length) ? path[0] : e.target;
    if (isTypingTarget(source) || isTypingTarget(deepActiveElement())) return;
    let handled = true;
    switch (e.key) {
      case CONFIG.keys.faster: stepRate(+CONFIG.step, { toast: true }); break;
      case CONFIG.keys.slower: stepRate(-CONFIG.step, { toast: true }); break;
      case CONFIG.keys.reset: setDesiredRate(1, { toast: true }); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* ------------------------------------------------------------------ *
   * Guardian — keeps the panel mounted across SPA navigation and keeps   *
   * the active video pinned to the desired rate.                        *
   * ------------------------------------------------------------------ */
  function tick() {
    buildUi(); // re-mounts if Bilibili's SPA wiped our node
    const videos = document.querySelectorAll('video, audio');
    for (let i = 0; i < videos.length; i++) {
      if (readRate(videos[i]) !== desiredRate) writeRate(videos[i], desiredRate);
    }
  }

  function init() {
    buildUi();
    updateUi();
    document.addEventListener('fullscreenchange', relocateHost, true);
    document.addEventListener('webkitfullscreenchange', relocateHost, true);
    window.addEventListener('resize', clampPanel);
    setInterval(tick, 1000);
  }

  if (document.documentElement) {
    init();
  } else {
    document.addEventListener('readystatechange', init, { once: true });
  }
})();
