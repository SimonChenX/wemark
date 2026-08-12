# WeMark Privacy Policy

**[隐私权政策（中文）→](PRIVACY.md)**

Last updated: August 12, 2026

WeMark (WeChat Article to Markdown) is an open-source Chrome browser extension. **We take your privacy seriously: this extension collects, stores, and uploads no personal information or browsing data whatsoever.** This policy explains how the extension handles data and what each permission is used for.

## 1. We Collect No Data

- ❌ No personal information (names, email addresses, accounts, etc.)
- ❌ No browsing history, lists of visited websites, or bookmarks
- ❌ No usage statistics, analytics, or logs
- ❌ No cookies, fingerprinting, or tracking technologies of any kind
- ❌ No remote servers: the extension has no backend whatsoever; all content processing happens locally in your browser
- ❌ No data sharing or selling to third parties (because no such data exists)

## 2. Data Processed Locally

The following data exists only in your own browser and on your own computer. The extension never sends it anywhere:

| Data | Handling |
|---|---|
| Article body, title, publish time, images | Read and converted to Markdown/HTML files in your browser only when you explicitly click save or start a batch import; saved to the subdirectory under Downloads that you configured |
| Save preferences (save directory, per-article folder, local images, save-as-HTML) | Stored locally via the browser's built-in `chrome.storage` (if Chrome sync is enabled, the preference values themselves sync with your browser account — this sync is performed by the Chrome browser and is unrelated to any extension server, because the extension has no server) |

## 3. Permission Purposes

| Permission | Purpose |
|---|---|
| `storage` | Persists the save preferences you configure in the Settings tab so they survive browser restarts |
| `downloads` | Writes the converted Markdown/HTML files and article images to the subdirectory under Downloads that you specified |
| `tabs` | Batch import: opens article links in background tabs, waits for pages to finish loading, and closes the tabs after saving |
| Host permission (`mp.weixin.qq.com`) | The content script is injected only into WeChat Official Account article pages to read the article body and perform the conversion; it accesses no other websites |

## 4. Third-Party Services

- **WeChat image CDN (mmbiz.qpic.cn)**: When saving an article, the extension requests the article's images in order to save them locally. These requests are made by your browser directly to Tencent's WeChat image servers. Please refer to Tencent's privacy policies for how such requests are handled.
- **Third-party libraries**: The extension bundles the open-source library [Turndown](https://github.com/mixmark-io/turndown) (MIT license) for HTML-to-Markdown conversion. It runs entirely locally and makes no network requests.

## 5. Children's Privacy

The extension collects no data from anyone, including children under 13.

## 6. Changes to This Policy

If this policy changes, we will update this file in the repository and revise the "Last updated" date. Since the extension collects no data, we do not anticipate any substantive changes.

## 7. Contact Us

If you have any questions about this privacy policy, please contact us by:

- Opening an Issue on the GitHub repository
- Repository: https://github.com/ (replace with your repository URL)

---

*This extension is open source under the MIT license and its source code is publicly auditable. We encourage you to read the source code to verify every claim in this policy.*
