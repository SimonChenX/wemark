# WeMark — WeChat Article to Markdown

> A Chrome extension that saves WeChat Official Account articles (`mp.weixin.qq.com`) as Markdown (+ optional HTML) with one click — custom save directory, per-article folders, local images, and batch import.

**[中文版 →](README.md)**

## Features

- ✅ Toolbar popup with three tabs: **Settings / Single Save / Batch Import**
- ✅ **Markdown and HTML are saved as two independent documents**, sharing the same local images (`images/` directory) — replace an image file once and both documents are updated
- ✅ **Batch import**: paste a URL list or import a `.txt` file; the browser visits and saves each article automatically (background tabs, live progress, failed items on top, copy results with one click, stoppable)
- ✅ Keyboard shortcut `Cmd/Ctrl+Shift+M` saves using the stored settings
- ✅ Images are downloaded into the article folder's `images/` subdirectory (deduplicated; falls back to the original URL on failure)
- ✅ Title and publish time are extracted into the Markdown header automatically
- ✅ Body conversion: headings, bold, italic, blockquotes, lists, code blocks, tables (GFM), horizontal rules
- ✅ WeChat lazy-loaded images handled automatically (`data-src` → full image URL)
- ✅ Embedded WeChat videos / audio / mini-program cards become placeholder notes + links
- ✅ Irrelevant nodes (QR codes, like areas, scripts, etc.) are cleaned up automatically
- ✅ Real-time progress bar (image downloads) + in-page toast feedback

## Installation

### Chrome Web Store

Once published, search for "WeMark" on the [Chrome Web Store](https://chromewebstore.google.com) and install.

### Load Unpacked (from source)

1. Open Chrome and visit `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this project directory (the one containing `manifest.json`)
4. A green "MD" icon appears in the toolbar (pin it via the puzzle icon if you like)

## Usage

The popup has three tabs: **Settings** / **Single Save** / **Batch Import**.

### Settings (global, applied to both single and batch saves)

- **Save directory**: path relative to the browser's Downloads folder; subpaths supported (e.g. `WeChatArticles/2026`)
- **Per-article folder**: creates a folder named after the article title
- **Download images locally**: saves images into the `images/` subdirectory
- **Also save an HTML copy**: saved alongside the Markdown, referencing the same local images (on by default)

Click the **Save Settings** button to persist changes; the directory preview updates in real time.

### Single Save

1. Open a WeChat article (`mp.weixin.qq.com/s/...`) and wait until the body images finish loading
2. Click the toolbar icon (opens on the Single Save tab with a settings summary at the top)
3. Click **Save Current Article**; the save path is shown when the progress bar completes
4. Or press `Cmd+Shift+M` (macOS) / `Ctrl+Shift+M` (Windows/Linux) to save directly with the current settings

### Batch Import

1. Click the extension icon and switch to the **Batch Import** tab (settings summary shown at the top)
2. Paste article links into the text box (one per line, any separators work, duplicates removed automatically), or click **Import .txt file**
3. Click **Start Batch Save**; the extension will automatically:
   - open each link in a **background tab** (your browsing is not interrupted)
   - wait for the page to load → extract the body → download images → save Markdown + HTML → close the tab
4. The list shows each item's status in real time (pending / saving… / done / failed) with **failed items moved to the top**; use **Copy Results** in the summary bar to copy the report to the clipboard; click **Stop** anytime to abort the remaining tasks

## Output Structure

With per-article folder, local images and HTML enabled:

```
Downloads/WeChatArticles/<Article Title>/
├── <Article Title>.md
├── <Article Title>.html   ← standalone HTML (references the same images/, inline styles, opens directly in a browser)
└── images/
    ├── 001.png
    ├── 002.png
    └── ...
```

Both Markdown and HTML reference images with relative paths: `![](images/001.png)` / `<img src="images/001.png">`, so they preview locally out of the box.

## Project Structure

```
├── manifest.json            # MV3 manifest (permissions: storage, downloads, tabs)
├── background.js            # Service Worker: download orchestration, batch queue, progress broadcast
├── content.js               # Article extraction & HTML→Markdown conversion (image placeholders)
├── popup.html / .css / .js  # Popup: Settings / Single Save / Batch Import views
├── lib/
│   ├── turndown.js          # HTML→Markdown converter (v7.2.0, MIT)
│   └── turndown-plugin-gfm.js # GFM plugin: tables/strikethrough/task lists (MIT)
├── icons/                   # Extension icons
└── tools/
    ├── make_icons.py        # Icon generator (pure Python)
    ├── test_local.mjs       # jsdom integration test (single-article conversion)
    └── test_batch.mjs       # Batch queue unit tests (mocked chrome APIs)
```

## Technical Notes

- **Manifest V3**: the Service Worker orchestrates downloads; the content script is only injected into `mp.weixin.qq.com`
- Image placeholder protocol: content.js emits `@@WXIMG@@index@@`, which background.js replaces with local relative paths after downloading
- Identical image URLs are downloaded only once (deduplication); on failure the original WeChat URL is kept
- Downloads use the `chrome.downloads` API (`conflictAction: uniquify` avoids overwrites); all paths are sanitized for illegal characters
- Conversion is based on [Turndown](https://github.com/mixmark-io/turndown) (MIT) with custom rules for the WeChat DOM (lazy-loaded images, `<mpvideosnap>`, `<mpvoice>`, etc.)
- Batch import: background tabs (`active: false`) loaded one by one with a 45s per-page timeout; `START_BATCH` validates synchronously and returns immediately while the queue runs asynchronously; stop/single-save mutual exclusion is guaranteed by a global `busy` lock

### Cross-Platform Compatibility (Windows / macOS / Linux)

- Filenames filter `\ / : * ? " < > |`, control characters and zero-width characters (the union of illegal characters across all three systems)
- Windows reserved device names (`CON`, `PRN`, `NUL`, `COM1-9`, `LPT1-9`, including forms like `nul.md`) are prefixed with `_`
- Trailing dots/spaces (forbidden on Windows) and leading dots (to avoid hidden files) are stripped
- Path segments always use `/`; `chrome.downloads` converts them to `\` on Windows
- Windows MAX_PATH (260 chars) protection: base directory capped at 120 chars; article folder names are truncated when the total relative path is too long

## Local Testing

```bash
# Install jsdom anywhere first (Node >= 18)
npm install jsdom
node tools/test_local.mjs <saved article .html> [output .md path]
node tools/test_batch.mjs
```

## Permissions

This extension requests only the three permissions required for its core functionality. It collects no user data and uploads nothing:

| Permission | Purpose |
|---|---|
| `storage` | Persists the 4 save preferences configured in the Settings tab (save directory, per-article folder, local images, save-as-HTML). Stored in `chrome.storage.sync` so settings survive restarts and sync across devices; used for nothing else |
| `downloads` | Writes the converted Markdown / HTML files and article images into the user-configured subdirectory under Downloads — the core function of the extension |
| `tabs` | Opens article links in background tabs during batch import (without interrupting your browsing), waits for pages to finish loading before extraction, and closes tabs automatically after saving |

## FAQ

**Q: "Cannot communicate with the page — please refresh the article and retry"?**
A: After installing/updating the extension, refresh the article page so the content script gets injected.

**Q: Some images were not downloaded?**
A: Failed images automatically keep the original WeChat URL (`mmbiz.qpic.cn`). WeChat's image CDN has hotlink protection; some Markdown previews may not display them — retry the save if needed.

**Q: Where are saved files?**
A: Under your configured subdirectory inside the browser's Downloads folder (the completion toast shows the full path).

**Q: Tables not converted?**
A: Tables without a header row (first row not `<th>`) are kept as raw HTML — a GFM syntax limitation.

## Privacy & License

- 📄 [Privacy Policy](PRIVACY.en.md) — This extension collects no user data; all processing happens locally
- ⚖️ Licensed under the [MIT License](LICENSE)

Third-party dependencies (bundled in `lib/`, both MIT licensed):

- [Turndown](https://github.com/mixmark-io/turndown) — HTML to Markdown converter
- [turndown-plugin-gfm](https://github.com/mixmark-io/turndown-plugin-gfm) — GitHub Flavored Markdown support

## Acknowledgements

[Simon's Blog](https://blog.glemon.cn/)

## Friend Links

[LINUX DO](https://linux.do)