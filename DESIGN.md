# 网页文章规范化排版 · Edge 扩展设计方案

> 目标：把已跑通的排版逻辑（原 `format.js`）从"浏览器外面"搬进页面内部，做成一个同事都能装的 Edge 浏览器扩展，一键完成正文规范化排版。

---

## 1. 背景与问题本质

### 1.1 现状
现有能力是一个 TRAE skill + `format.js`：通过浏览器自动化（browseruse）把 JS 注入页面、驱动 UEditor 排版、再读回校验。

### 1.2 痛点
排版逻辑跑在**浏览器之外**，于是派生出一堆与业务无关的问题：

| 痛点 | 原因 |
|---|---|
| 跨 iframe 取内容不稳定 | 自动化工具需要穿透 UEditor 的内层 iframe |
| 截图/桥接经常超时 | 每次都靠外部工具往返通信 |
| 必须保持会话、保持标签页 | 自动化依赖已打开的页面状态 |
| 无法交给同事复用 | 需要装一整套自动化环境 |

### 1.3 第一性原理
> **排版逻辑本就应该跑在页面里。**

UEditor 的正文就在页面的 iframe 里，`window.UE.instants` 就在页面的主世界。只要换一个"载体"把已有 JS 送进页面，上述痛点**全部消失**。问题不是"要不要重写逻辑"，而是"用什么载体把逻辑送进去"。

### 1.4 为什么选 Edge 扩展（而非油猴脚本）
| 维度 | 油猴脚本 (Tampermonkey) | Edge 扩展 (MV3) |
|---|---|---|
| 前提 | 需先装 Tampermonkey（可能被公司策略禁用） | 直接装，无中间依赖 |
| 分发 | 发 `.user.js` 或走 GreasyFork | 可打包 `.crx`/文件夹，或上架 Edge 加载项商店 |
| 上架成本 | 低 | Edge 商店**免费**（Chrome 需 $5） |
| 能力上限 | 受宿主脚本管理器约束 | 完整扩展 API（工具栏图标、快捷键、存储） |
| 内核 | — | Edge 是 Chromium 内核，代码与 Chrome 扩展**完全通用** |

用户最终选择：**Edge 扩展**。

---

## 2. 关键技术约束与解法

### 2.1 MV3 隔离世界（本方案唯一的核心难点）
- MV3 content script 默认运行在 **isolated world**，拿不到页面的 `window.UE`（UEditor 实例所在的全局对象）。
- 解法：让引擎脚本声明 `"world": "MAIN"`，直接在页面主世界运行，从而可访问 `window.UE`。
- **代价**：MAIN world 里**没有 `chrome.*` API**，无法直接调扩展能力、无法直接弹 UI。

### 2.2 双世界通信
MAIN world（引擎）与 ISOLATED world（UI）共享同一个 DOM，用 **`CustomEvent` 在 `document` 上互通**。
- 事件 `detail` 一律用 **JSON 字符串**承载（跨世界传对象存在兼容性坑，字符串最稳）。

### 2.3 回写后的同步
UEditor `setContent()` 之后，为保证后台表单能读到改动，需补：
- `ed.sync()`（若存在）
- `ed.fireEvent('contentchange')`

### 2.4 中英混排字体
保留**按字符拆 `<span>`** 的方案（而非纯 CSS 字体栈），原因：验收标准是"编辑器字体下拉框选中文时显示宋体"，拆 span 才能让编辑器的字体面板识别正确；同时复制粘贴时样式可跟随。

---

## 3. 文件结构

```
edge-typesetting/
├── manifest.json              # MV3 清单：双世界 content script 声明
├── src/
│   ├── engine.js              # MAIN world：排版引擎（由 format.js 移植）
│   ├── bridge.js              # ISOLATED world：悬浮按钮 UI + 事件桥 + 撤销
│   └── background.js          # service worker：工具栏图标点击 → 通知页面
├── assets/
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── test/
│   └── ueditor-mock.html      # 模拟 UEditor 环境的本地测试页
├── DESIGN.md                  # 本文件
└── README.md                  # 给同事的安装与使用说明
```

---

## 4. 双世界通信协议

所有事件在 `document` 上收发，`detail` 为 JSON 字符串。

| 事件名 | 方向 | detail | 说明 |
|---|---|---|---|
| `tws:probe` | ISOLATED → MAIN | `{}` | 询问主世界是否存在编辑器 |
| `tws:probe-result` | MAIN → ISOLATED | `{found, editorName, contentLength}` | 探测结果 |
| `tws:format` | ISOLATED → MAIN | `{options}` | 请求执行排版 |
| `tws:format-result` | MAIN → ISOLATED | `{ok, report, backupLength}` 或 `{ok:false, error}` | 排版与校验结果 |
| `tws:undo` | ISOLATED → MAIN | `{}` | 请求撤销到排版前 |
| `tws:undo-result` | MAIN → ISOLATED | `{ok, error}` | 撤销结果 |

---

## 5. 数据流

```
[工具栏图标点击] → background.js → chrome.tabs.sendMessage
                                            │
[悬浮按钮点击] ─────────────────────────────┤
                                            ▼
                              bridge.js（ISOLATED world）
                                    派发 tws:probe / tws:format
                                            ▼
                              engine.js（MAIN world）
              findUEditor() → 备份 → cleanDocument() → formatArticle() → setContent() → verifyArticle()
                                            ▼
                       回报 tws:probe-result / tws:format-result
                                            ▼
                   bridge.js 弹提示 + 「撤销」按钮（可一键回滚）
```

---

## 6. 触发方式（已确认：两者都要）

1. **悬浮按钮**：仅在检测到编辑器的页面出现；固定在右下角，不遮挡；不自动排版（必须手动点）。
2. **工具栏图标**：点击扩展图标 = 触发一次排版（等价于点悬浮按钮）。

> 不做自动运行，避免误改内容。

---

## 7. 安全与可逆

- **不改 CMS 代码**，纯客户端注入（用户已确认前端改不了）。
- **不自动执行**，一切由用户点击触发。
- **内存备份 + 一键撤销**：排版前记录 `ed.getContent()`，撤销即 `setContent(backup)`，也会回滚标签页，无需刷新。
- **权限最小化原则**：开发期 `matches` 先用通配符（`<all_urls>`）便于调试；**正式分发/上架前必须收窄到真实 CMS 域名**（用户将在后续提供）。

---

## 8. 排版规则（沿用既有标准）

**流程（0.2.0 起）**：排版前先执行 `cleanDocument()` **清除全部格式**，再套统一排版。清除范围：

| 处理 | 内容 |
|---|---|
| 移除 | 注释（含 Word 条件注释）、`script/style/meta/link/noscript/template/iframe/o:p` |
| 清属性 | 所有元素的格式属性（style、class、id、width、align 等） |
| 解包（保留文字） | `span/font/b/strong/i/em/u/s/strike/del/ins/mark/sub/sup` 等内联修饰标签 |
| 转为段落 | `h1–h6`、`figcaption`、`center`、无块级后代的 `div` |
| 解包 | 有块级后代的 `div`、`figure/section/article/blockquote/pre` 等容器 |
| 保留 | 文字、段落 `p`、图片（仅 `src/alt`）、超链接（仅 `href/target`）、`br`、列表、表格结构 |

> 即 Word"清除所有格式"的语义：加粗、颜色、旧字体、标题层级全部清掉，之后按下方统一规则重排。

| 规则 | 值 |
|---|---|
| 正文字号 | 22px |
| 行距 | 1.5 |
| 中文/中文标点字体 | 宋体, SimSun |
| 英文/罗马数字字体 | 'Times New Roman', serif |
| 基础字体栈 | "Times New Roman", SimSun, serif |
| 正文段落 | 两端对齐 + 首行缩进 2em |
| 图片段 | 居中、不缩进、`max-width:100%` |
| 图标题段（以 `图 N` 开头） | 居中、不缩进 |
| 空段落 | 居中、不缩进 |

---

## 9. 开发与验证

1. **本地测试**：`python -m http.server` 托管 `test/ueditor-mock.html`（模拟 `window.UE` + 内层 iframe），直接加载扩展验证。
2. **真实 CMS**：在真实编辑器页面验证"选中中文 → 字体下拉框显示宋体"、图标题居中、撤销可用。
3. **无构建步骤**：纯原生 JS，改完直接刷新扩展即可。

---

## 10. 已知风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 公司策略禁用扩展 | 企业策略可能禁止侧载 | 需实测；必要时走 Edge 商店 |
| 字体依赖本机字库 | 无宋体的机器会回退 | 宋体为 Windows 默认，风险低 |
| 域名收窄 | 通配符权限过大 | 上架前替换为真实域名 |
| 编辑器版本差异 | 非 UEditor 的编辑器不识别 | 引擎定位逻辑可扩展 |
| 正文体积膨胀 | 拆 span 导致 HTML 变大 | 可接受；如需可切换纯 CSS 模式 |
