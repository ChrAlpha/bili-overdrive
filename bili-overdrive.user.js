// ==UserScript==
// @name         Bili Overdrive 强制倍速
// @name:en      Bili Overdrive - Force Playback Speed
// @namespace    https://github.com/ChrAlpha/bili-overdrive
// @version      2.0.1
// @description  强制手动控制 Bilibili 播放倍速，未登录也能用。自带倍速菜单原位接管播放器「倍速」按钮 + 快捷键，记忆上次倍速。
// @description:en  Force manual playback-speed control on Bilibili even when logged out. A self-contained speed menu takes over the player's native 倍速 slot, plus keyboard shortcuts, remembers last speed.
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
    presets: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
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
  const formatRate = (r) => (+r.toFixed(2)).toString() + '×'; // toast: e.g. 1.25×
  // Bilibili-native label style for the in-bar control: "2.0x", "1.25x", "0.5x".
  const nativeLabel = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2))) + 'x';

  /* ------------------------------------------------------------------ *
   * State.                                                              *
   * ------------------------------------------------------------------ */
  let desiredRate = clamp(Number(store.get('rate', 1)) || 1);

  // Patch the page's real prototype (not the userscript sandbox's view).
  const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Guard against a second instance (e.g. installed twice). Prefer a sentinel
  // attribute on <html>: it is a shared DOM node visible across every sandbox
  // realm and always writable, so it works even on managers that don't share
  // unsafeWindow. The window flag is a belt-and-suspenders fallback. Bail before
  // adding listeners/intervals/UI.
  try {
    const rootEl = document.documentElement;
    if (rootEl) {
      if (rootEl.hasAttribute('data-bili-overdrive')) return;
      rootEl.setAttribute('data-bili-overdrive', '1');
    }
  } catch (e) { /* ignore */ }
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
        // Use the same clamp/round2 normalization as the adopt branch below so
        // a near-1 reset (e.g. 1.001) can't slip through and clobber the rate.
        if (clamp(v) === 1 && desiredRate !== 1) {
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
   * UI — two surfaces, both fully self-owned:                           *
   *   1. An in-player speed control that takes over the native 倍速      *
   *      slot in the control bar (light DOM, styled to match natively).  *
   *   2. A transient center toast for keyboard changes (Shadow DOM).     *
   * We render our own menu so we depend on Bilibili only for an anchor   *
   * element — never on its (lockable) speed menu, handlers, or classes.  *
   * ------------------------------------------------------------------ */

  // Toast (Shadow DOM, isolated from site CSS).
  let shadow = null;
  let host = null;
  let toastEl = null;
  let toastTimer = null;

  // In-bar control (light DOM, lives inside the player's control bar).
  let barCtrl = null;
  let barResultEl = null;
  let barItemEls = [];
  let cssInjected = false;

  let uiRaf = 0;
  let mountScheduled = 0;

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

  // Coalesce MutationObserver bursts (Bilibili churns the DOM constantly) into
  // at most one ensureBarControl() per frame-ish window.
  function scheduleMount() {
    if (mountScheduled) return;
    mountScheduled = setTimeout(() => {
      mountScheduled = 0;
      ensureBarControl();
    }, 50);
  }

  function updateUi() {
    // In-bar control: result text mirrors native (倍速 at 1x, else "1.5x").
    if (barResultEl) {
      barResultEl.textContent =
        Math.abs(desiredRate - 1) < 1e-6 ? '倍速' : nativeLabel(desiredRate);
    }
    for (const li of barItemEls) {
      const active = Math.abs(parseFloat(li.dataset.r) - desiredRate) < 1e-6;
      li.classList.toggle('bod-active', active);
    }
  }

  /* ---- Styles: hide the native control, dress ours to match. -------- */
  function injectCss() {
    if (cssInjected) return;
    if (!document.documentElement) return;
    const style = document.createElement('style');
    style.id = 'bili-overdrive-style';
    // Selectors are scoped under #bili-overdrive-ctrl and carry explicit
    // box-sizing/margin/padding resets, because this control lives in the light
    // DOM (inside the player's control bar) where site CSS can otherwise cascade
    // onto our generic <div>/<ul>/<li> nodes.
    //
    // The control element also wears Bilibili's own `bpx-player-ctrl-btn` class
    // so it inherits the correct button height/line-height for the *current*
    // player mode (the bar grows from 22px to 43px tall in fullscreen / web
    // fullscreen). We deliberately do NOT hard-code height/line-height here, so
    // our 倍速 text stays vertically aligned with its neighbours in every mode.
    style.textContent = `
      /* Replace Bilibili's native speed control with our own. */
      .bpx-player-ctrl-playbackrate { display: none !important; }

      #bili-overdrive-ctrl.bod-ctrl {
        position: relative; box-sizing: border-box; min-width: 50px;
        margin: 0 10px 0 0; cursor: pointer; outline: none; color: #fff;
      }
      #bili-overdrive-ctrl .bod-result {
        box-sizing: border-box; margin: 0; padding: 0; min-width: 50px;
        font-size: 14px; font-weight: 600; white-space: nowrap;
        text-align: center; color: #fff; cursor: pointer;
      }
      /* Transparent hover bridge, as wide as the menu, so moving the cursor up
         to the menu (incl. its overhanging edges) never drops :hover. */
      #bili-overdrive-ctrl::after {
        content: ''; position: absolute; bottom: 100%;
        left: 50%; transform: translateX(-50%); width: 72px; height: 14px;
        display: none;
      }
      #bili-overdrive-ctrl:hover::after, #bili-overdrive-ctrl:focus-within::after { display: block; }
      #bili-overdrive-ctrl .bod-menu {
        display: none; position: absolute; left: 50%; bottom: calc(100% + 12px);
        transform: translateX(-50%); margin: 0; padding: 0; list-style: none;
        width: 72px; box-sizing: border-box;
        background-color: rgba(20, 20, 20, 0.9); border-radius: 2px;
        text-align: center; z-index: 100;
      }
      #bili-overdrive-ctrl:hover .bod-menu, #bili-overdrive-ctrl:focus-within .bod-menu { display: block; }
      #bili-overdrive-ctrl .bod-item {
        box-sizing: border-box; margin: 0; padding: 0;
        height: 36px; line-height: 36px; cursor: pointer;
        color: #fff; font-size: 14px; list-style: none;
      }
      #bili-overdrive-ctrl .bod-item:hover { background-color: rgba(255, 255, 255, 0.1); }
      #bili-overdrive-ctrl .bod-item.bod-active { color: var(--bpx-primary-color, #00AEEC); font-weight: 600; }
    `;
    (document.head || document.documentElement).appendChild(style);
    cssInjected = true;
  }

  /* ---- The in-bar speed control. ----------------------------------- */
  // Presets ordered high -> low, matching the native menu.
  const menuOrder = () => CONFIG.presets.slice().sort((a, b) => b - a);

  function buildBarControl() {
    const ctrl = document.createElement('div');
    // Reuse Bilibili's native button class for per-mode layout (height /
    // line-height / vertical centering); `bod-ctrl` adds our own positioning.
    ctrl.className = 'bpx-player-ctrl-btn bod-ctrl';
    ctrl.id = 'bili-overdrive-ctrl';
    ctrl.setAttribute('role', 'button');
    ctrl.setAttribute('aria-label', '倍速');
    ctrl.setAttribute('tabindex', '0');

    const result = document.createElement('div');
    result.className = 'bod-result';
    result.textContent = '倍速';

    const menu = document.createElement('ul');
    menu.className = 'bod-menu';

    barItemEls = menuOrder().map((r) => {
      const li = document.createElement('li');
      li.className = 'bod-item';
      li.dataset.r = String(r);
      li.textContent = nativeLabel(r);
      li.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDesiredRate(r);
      });
      menu.appendChild(li);
      return li;
    });

    ctrl.appendChild(result);
    ctrl.appendChild(menu);
    barCtrl = ctrl;
    barResultEl = result;
    return ctrl;
  }

  // Mount (or remount) our control in the native 倍速 slot. Idempotent and
  // cheap; called on a timer so it survives Bilibili's SPA re-renders.
  function ensureBarControl() {
    injectCss();
    const native = document.querySelector('.bpx-player-ctrl-playbackrate');

    // Already mounted: keep it parked right where the native control would be.
    if (barCtrl && document.documentElement.contains(barCtrl)) {
      if (native) {
        native.style.display = 'none';
        if (native.previousElementSibling !== barCtrl && native.parentElement) {
          native.parentElement.insertBefore(barCtrl, native);
        }
      }
      return;
    }

    // Pick an anchor: the native slot first, then the control-bar containers.
    const parent =
      (native && native.parentElement) ||
      document.querySelector('.bpx-player-control-bottom-right') ||
      document.querySelector('.bpx-player-control-bottom');
    if (!parent) return; // control bar not ready yet — retry next tick

    const ctrl = buildBarControl();
    if (native) {
      native.style.display = 'none';
      native.parentElement.insertBefore(ctrl, native);
    } else {
      parent.appendChild(ctrl);
    }
    updateUi();
  }

  /* ---- The toast (Shadow DOM). ------------------------------------- */
  function buildToast() {
    if (host && document.documentElement.contains(host)) return;
    if (!document.documentElement) return;

    host = document.createElement('div');
    host.id = 'bili-overdrive-host';
    host.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .toast {
          position: fixed; left: 50%; top: 14%; transform: translateX(-50%);
          pointer-events: none; padding: 8px 18px; border-radius: 10px;
          background: rgba(0,0,0,0.78); color: #fff; font-size: 22px; font-weight: 700;
          opacity: 0; transition: opacity .18s; letter-spacing: 1px;
          font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .toast.show { opacity: 1; }
      </style>
      <div class="toast"></div>
    `;
    toastEl = shadow.querySelector('.toast');
    document.documentElement.appendChild(host);
    relocateHost(); // if we're already in fullscreen, mount into that subtree
  }

  // Native fullscreen promotes the player container to the browser top layer,
  // where only its descendants paint. Re-parent our toast host into the
  // fullscreen element so it stays visible; move it back on exit.
  function relocateHost() {
    if (!host) return;
    const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
    const parent = fs || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
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
   * Guardian — keeps the control mounted across SPA navigation and keeps *
   * the active video pinned to the desired rate.                        *
   * ------------------------------------------------------------------ */
  function tick() {
    buildToast();       // re-mounts if Bilibili's SPA wiped our node
    ensureBarControl(); // re-mounts / reparks our in-bar control
    updateUi();
    const videos = document.querySelectorAll('video, audio');
    for (let i = 0; i < videos.length; i++) {
      if (readRate(videos[i]) !== desiredRate) writeRate(videos[i], desiredRate);
    }
  }

  function init() {
    injectCss();
    buildToast();
    ensureBarControl();
    updateUi();
    document.addEventListener('fullscreenchange', relocateHost, true);
    document.addEventListener('webkitfullscreenchange', relocateHost, true);
    // Mount the moment the player/control bar appears or is rebuilt, instead of
    // waiting for the next 1s tick (avoids a brief empty speed slot on load and
    // SPA navigation). The interval below remains a fallback.
    if (typeof MutationObserver === 'function' && document.documentElement) {
      try {
        new MutationObserver(scheduleMount)
          .observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) { /* ignore */ }
    }
    setInterval(tick, 1000);
  }

  if (document.documentElement) {
    init();
  } else {
    document.addEventListener('readystatechange', init, { once: true });
  }
})();
