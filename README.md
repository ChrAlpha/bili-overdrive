# Bili Overdrive 强制倍速

未登录访问 [bilibili.com](https://www.bilibili.com) 时，播放器会禁用倍速菜单并把 `playbackRate` 强制重置回 `1×`。这个 Tampermonkey 用户脚本强制接管倍速控制 —— **不登录也能任意调速**。

A Tampermonkey userscript that forces manual playback-speed control on Bilibili, even when you're logged out (Bilibili disables its speed menu and resets `playbackRate` to `1×` for logged-out users).

<p align="center">
  <img src="./assets/bili-speed.png" alt="未登录时 B 站倍速菜单显示「登录可享」 / Bilibili's speed menu shows '登录可享' (login required) when logged out" width="320">
  <br>
  <em>未登录时倍速被锁为「登录可享」—— 本脚本绕过它。<br>Logged out, the speed menu is locked behind “登录可享” — this script bypasses it.</em>
</p>

## 功能 Features

- **强制调速**：重写 `HTMLMediaElement.prototype.playbackRate`，拦截 B 站把倍速复位到 `1×` 的行为，让你设定的倍速「粘住」。
- **浮动面板**：可拖动的小面板，预设 `0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 3 / 5×`，加减按钮 + 一键复位。面板用 Shadow DOM 隔离，不被站点样式污染。
- **键盘快捷键**：
  - `]` 加速（步进 0.25）
  - `[` 减速（步进 0.25）
  - `\` 恢复 1×
  - 调速时播放器中央会有短暂提示。
- **记忆倍速**：记住上次使用的倍速（及面板位置），换视频 / 刷新后自动套用。
- **全屏可用**：进入原生全屏时面板与提示会自动重挂到全屏元素内，依然可见可用。
- **范围**：`0.25×` ~ `16×`（键盘可微调到 16×，预设到 5×）。

## 适用页面 Scope

- 普通视频：`https://www.bilibili.com/video/*`
- 番剧：`https://www.bilibili.com/bangumi/play/*`
- 活动 / 拜年祭：`https://www.bilibili.com/festival/*`（部分分享视频会跳转到该地址，未登录同样受限）

> 直播（`live.bilibili.com`）未包含 —— 直播流的倍速本身不稳定。

## 安装 Install

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）。
2. 打开 [`bili-overdrive.user.js`](https://github.com/ChrAlpha/bili-overdrive/raw/main/bili-overdrive.user.js) 链接，脚本管理器会提示安装；或在 Tampermonkey 里「新建脚本」并粘贴文件内容。
3. 打开任意 B 站视频页，右下角会出现倍速面板。

## 工作原理 How it works

脚本在 `@run-at document-start` 时机（早于 B 站播放器代码）重定义 `HTMLMediaElement.prototype.playbackRate` 的 setter：

- 你自己的面板 / 快捷键通过**原生 setter** 直接写入，作为唯一可信来源（`desiredRate`）。
- 当外部代码（B 站）尝试把倍速写成 `1×`、而你想要的是非 `1×` 时，视为「登录墙复位」并重新强制回你的倍速。
- 外部写入的**非 `1×`** 值（例如登录用户用原生菜单选的倍速、或恢复的历史倍速）会被采纳并同步到面板。
- 额外保险：捕获阶段的 `ratechange` 守卫 + 1 秒轮询，应对 SPA 换页与新建的 `<video>` 元素。

## 自定义 Customize

打开脚本顶部的 `CONFIG` 对象即可修改预设倍速、步进、上下限和快捷键：

```js
const CONFIG = {
  presets: [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5],
  step: 0.25,
  min: 0.25,
  max: 16,
  keys: { faster: ']', slower: '[', reset: '\\' },
};
```

## 说明 Notes

- 仅作个人学习与无障碍使用。请遵守 Bilibili 的服务条款。
- 极高倍速（如 8× / 16×）下音频可能卡顿或静音，这是浏览器解码限制，非脚本问题。

## License

MIT — see [LICENSE](./LICENSE).
