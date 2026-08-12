# WeMark — 微信文章转 Markdown

> 一个 Chrome 扩展：将微信公众号文章一键保存为 Markdown（+ 可选 HTML），支持自定义目录、每篇文章独立文件夹、图片本地化、批量导入。
>
> A Chrome extension that saves WeChat Official Account articles (`mp.weixin.qq.com`) as Markdown (+ optional HTML) with one click.

**[English Version →](README.en.md)**

## 功能特性

- ✅ 点击工具栏图标弹出面板，分三个标签页：**设置 / 单篇保存 / 批量导入**
- ✅ **Markdown 与 HTML 各按各的格式保存**：两者都是标准独立文档，共享同一批本地图片（`images/` 目录），替换图片文件即可同步更新两个文档
- ✅ **批量导入**：粘贴 URL 列表或导入 `.txt` 文件，浏览器自动逐篇访问并保存（后台标签页、实时进度、失败项置顶、一键复制结果、可中途停止）
- ✅ 快捷键 `Cmd/Ctrl+Shift+M` 按已保存设置直接保存
- ✅ 图片下载到文章文件夹的 `images/` 子目录（自动去重、失败保留原链接）
- ✅ 自动提取标题与发布时间写入 Markdown 头部
- ✅ 正文格式转换：标题、加粗、斜体、引用、列表、代码块、表格（GFM）、分割线
- ✅ 自动处理微信懒加载图片（`data-src` → 完整图片链接）
- ✅ 微信内嵌视频 / 音频 / 小程序卡片转为占位说明 + 链接
- ✅ 自动清理二维码、点赞区、脚本等无关节点
- ✅ 实时进度条（图片下载进度）+ 页面 toast 反馈

## 安装

### Chrome 应用商店

商店上架后，直接在 [Chrome 应用商店](https://chromewebstore.google.com) 搜索「WeMark」安装即可。

### 开发者模式加载（本地源码）

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目目录（包含 `manifest.json` 的目录）
4. 工具栏出现绿色 "MD" 图标即安装成功（建议点击拼图图标将其固定）

## 使用方法

弹窗分为三个标签页：**设置** / **单篇保存** / **批量导入**。

### 设置（全局，对单篇与批量同时生效）

- **保存目录**：相对「下载」文件夹的路径，支持子路径（如 `WeChatArticles/2026`）
- **每篇文章独立文件夹**：开启后按文章标题建文件夹
- **图片下载到本地**：开启后图片存入 `images/` 子目录
- **同时保存一份独立 HTML**：与 Markdown 并存，图片同样引用本地 images/（默认开）

修改后点击「保存设置」按钮保存，页面内的目录结构预览可实时查看效果。

### 单篇保存

1. 打开一篇微信公众号文章（`mp.weixin.qq.com/s/...`），等待正文图片加载完成
2. 点击工具栏扩展图标（默认停在「单篇保存」页，顶部显示当前设置摘要）
3. 点击「保存当前文章」，进度条完成后显示保存路径
4. 也可直接使用快捷键 `Cmd+Shift+M`（macOS）/ `Ctrl+Shift+M`（Windows/Linux）按当前设置直接保存

### 批量导入

1. 点击扩展图标，切换到「批量导入」标签页（顶部同样显示当前设置摘要）
2. 在文本框粘贴文章链接（每行一个，任意分隔符均可，自动去重），或点击「导入 .txt 文件」选择链接列表文件
3. 点击「开始批量保存」，扩展将自动：
   - 逐篇在**后台标签页**打开链接（不打断当前浏览）
   - 等待页面加载完成 → 提取正文 → 下载图片 → 保存 Markdown + HTML → 自动关闭标签页
4. 列表实时显示每篇状态（等待 / 保存中… / 完成 / 失败），**失败项自动置顶**；汇总栏可**一键复制结果**到剪贴板；可随时点「停止」中断剩余任务

## 输出目录结构

开启「独立文件夹」「图片本地化」「保存 HTML」时：

```
下载/WeChatArticles/<文章标题>/
├── <文章标题>.md
├── <文章标题>.html   ← 独立 HTML（引用同一 images/，含内联样式，浏览器直接打开）
└── images/
    ├── 001.png
    ├── 002.png
    └── ...
```

Markdown 与 HTML 均使用相对路径引用图片：`![](images/001.png)` / `<img src="images/001.png">`，本地可直接预览。

## 项目结构

```
├── manifest.json            # MV3 扩展清单（权限：storage、downloads、tabs）
├── background.js            # Service Worker：下载编排（图片→Markdown/HTML）、批量队列、进度广播
├── content.js               # 文章提取与 HTML→Markdown 转换（图片占位符）
├── popup.html / .css / .js  # 弹窗：设置 / 单篇保存 / 批量导入 三视图
├── lib/
│   ├── turndown.js          # HTML→Markdown 转换库 (v7.2.0, MIT)
│   └── turndown-plugin-gfm.js # GFM 插件：表格/删除线/任务列表 (MIT)
├── icons/                   # 扩展图标
└── tools/
    ├── make_icons.py        # 图标生成脚本（纯 Python）
    ├── test_local.mjs       # jsdom 集成测试脚本（单篇转换）
    └── test_batch.mjs       # 批量队列单元测试（mock chrome API）
```

## 技术说明

- **Manifest V3**：Service Worker 编排下载流程，content script 仅注入 `mp.weixin.qq.com`
- 图片占位符协议：content.js 输出 `@@WXIMG@@序号@@`，background 下载图片后替换为本地相对路径
- 相同 URL 的图片只下载一次（去重）；单张失败时自动回退为微信原始链接
- 下载使用 `chrome.downloads` API（`conflictAction: uniquify` 避免覆盖），路径均做非法字符清理
- 转换基于 [Turndown](https://github.com/mixmark-io/turndown)（MIT），并针对微信 DOM 定制规则（懒加载图片、`<mpvideosnap>`、`<mpvoice>` 等）
- 批量导入：后台标签页（`active: false`）逐篇加载，单页 45s 加载超时保护；`START_BATCH` 同步校验立即返回，队列后台异步执行，STOP/单篇保存互斥均通过全局 `busy` 锁保证

### 跨平台兼容性（Windows / macOS / Linux）

- 文件名统一过滤 `\ / : * ? " < > |` 及控制字符、零宽字符（三大系统非法字符的并集）
- 兼容 Windows 保留设备名：`CON`、`PRN`、`NUL`、`COM1-9`、`LPT1-9`（含 `nul.md` 等带扩展名形式）自动加 `_` 前缀
- 去掉文件名结尾的点与空格（Windows 不允许），开头的点号（避免误识别为隐藏文件）
- 路径段统一使用 `/` 分隔符，由 `chrome.downloads` 在 Windows 下自动转换为 `\`
- 针对 Windows MAX_PATH（260 字符）限制：基础目录限长 120 字符，相对路径总长超限时自动截断文章文件夹名

## 本地测试

```bash
# 需先在任意目录安装 jsdom（Node >= 18）
npm install jsdom
node tools/test_local.mjs <微信文章HTML文件> [输出md路径]
node tools/test_batch.mjs
```

## 权限说明

本扩展仅申请实现核心功能所必需的三个权限，不收集任何用户数据、不上传任何内容：

| 权限 | 用途 |
|---|---|
| `storage` | 保存用户在「设置」页配置的 4 项保存偏好（保存目录、每篇文章独立文件夹、图片本地化、另存 HTML）。设置存储于 `chrome.storage.sync`，跨设备同步、持久保留，不用于存储其他任何数据 |
| `downloads` | 将转换后的 Markdown / HTML 文件与文章图片写入用户指定的「下载」子目录，这是扩展的核心功能 |
| `tabs` | 批量导入时在后台打开文章链接（不打断当前浏览）、等待页面加载完成后提取内容，保存完毕自动关闭标签页 |

## 常见问题

**Q：提示「无法与页面通信，请刷新文章页后重试」？**
A：刚安装/更新扩展后需刷新文章页，content script 才会注入。

**Q：个别图片没有下载下来？**
A：下载失败的图片会自动保留微信原始链接（`mmbiz.qpic.cn`）。微信图床有防盗链，部分 Markdown 预览器可能无法显示，可手动重试保存。

**Q：保存的文件在哪里？**
A：浏览器「下载」目录下的你设置的子目录中（popup 完成提示会显示完整路径）。

**Q：表格没有转换？**
A：无表头行（首行非 `<th>`）的表格会保留为 HTML 原样输出，这是 GFM 语法限制。

## 隐私与许可证

- 📄 [隐私权政策](PRIVACY.md) — 本扩展不收集任何用户数据，所有处理均在本地完成
- ⚖️ 本项目基于 [MIT 许可证](LICENSE) 开源

`lib/` 目录内打包的第三方依赖均为 MIT 协议：

- [Turndown](https://github.com/mixmark-io/turndown) — HTML 转 Markdown 转换器
- [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) — GitHub 风格 Markdown 支持

## 鸣谢

[Simon's Blog](https://blog.glemon.cn/)
 
## 友链
[LINUX DO](https://linux.do)
