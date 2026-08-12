/**
 * background.js — Service Worker（下载编排器）
 * background.js — Service Worker (download orchestrator)
 *
 * 职责 Responsibilities:
 *  1. 管理设置（chrome.storage.sync）：保存目录、独立文件夹、图片本地化、另存 HTML
 *     Manage settings (chrome.storage.sync): save directory, per-article folder,
 *     local images, save-as-HTML.
 *  2. 编排保存流程：提取文章 → 下载图片 → 替换占位符 → 保存 Markdown + HTML
 *     Orchestrate the save flow: extract article → download images →
 *     replace placeholders → save Markdown + HTML.
 *  3. 批量队列：逐篇在后台标签页加载并保存，支持停止 / 互斥 / 进度广播
 *     Batch queue: load & save articles one by one in background tabs,
 *     with stop / mutual exclusion / progress broadcast.
 *
 * License: MIT — see LICENSE
 */

const DEFAULT_SETTINGS = {
  baseDir: 'WeChatArticles',   // 相对「下载」目录，支持子路径如 WeChatArticles/2026
  perArticleFolder: true,      // 一篇文章一个文件夹
  downloadImages: true,        // 图片下载到本地 images/ 子目录
  saveHtml: true               // 同时保存一份独立 HTML
};

/** 图片占位符标记，与 content.js 保持一致 */
const IMG_MARK = '@@WXIMG@@';

/* ---------------- 设置存取 ---------------- */

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function saveSettings(settings) {
  await chrome.storage.sync.set(settings);
}

/* ---------------- 工具函数 ---------------- */

// Windows 保留设备名（带不带扩展名均非法，如 nul.md 也会被系统当作 NUL 设备）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

// 零宽与不可见 Unicode 字符（标题中常见 \u200b 零宽空格，会导致 downloads API 报 Invalid filename）
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f\u00ad\u180e\u200b-\u200f\u202a-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

/** 清理单个文件/文件夹名（兼容 Windows / macOS / Linux） */
function sanitizeName(name) {
  let s = String(name || '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')   // Windows 不允许结尾的点/空格
    .replace(/^[\s.]+/, '')   // 去掉开头的点/空格，避免空名或隐藏文件
    .slice(0, 80);
  if (!s) return '未命名文章';
  if (WIN_RESERVED.test(s)) s = '_' + s;
  return s;
}

/** 清理路径（相对下载目录），逐段 sanitize；'/' 在 Windows 下由 Chrome 自动转换 */
function sanitizePath(p) {
  return String(p || '')
    .split(/[/\\]+/)
    .filter((seg) => seg.trim() && seg !== '.' && seg !== '..')
    .map((seg) => sanitizeName(seg))
    .join('/')
    .slice(0, 120)            // 限制基础目录长度，防止 Windows MAX_PATH 超限
    .replace(/[.\s]+$/, '');
}

function joinPath(...parts) {
  return parts.filter(Boolean).join('/');
}

/** 从微信图片 URL 推断扩展名 */
function imageExtFromUrl(url) {
  try {
    const m = String(url).match(/wx_fmt=([a-z0-9]+)/i);
    if (m) {
      const fmt = m[1].toLowerCase();
      if (['png', 'gif', 'webp', 'bmp', 'jpeg', 'jpg'].includes(fmt)) {
        return fmt === 'jpeg' ? 'jpg' : fmt;
      }
    }
    const ext = String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i);
    if (ext) return ext[1].toLowerCase();
  } catch (e) { /* 忽略 */ }
  return 'jpg';
}

/**
 * 等待 chrome.downloads.download 完成，返回最终落盘的绝对路径
 * （conflictAction 为 uniquify 时实际文件名可能带后缀，需查询确认）
 */
function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename, conflictAction: 'uniquify', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (downloadId == null) {
          return reject(new Error('创建下载任务失败'));
        }
        const listener = (delta) => {
          if (delta.id !== downloadId || !delta.state) return;
          if (delta.state.current === 'complete') {
            chrome.downloads.onChanged.removeListener(listener);
            chrome.downloads.search({ id: downloadId }, (items) => {
              if (items && items[0] && items[0].filename) {
                resolve(items[0].filename);
              } else {
                resolve(filename);
              }
            });
          } else if (delta.state.current === 'interrupted') {
            chrome.downloads.onChanged.removeListener(listener);
            const reason = (delta.error && delta.error.current) || 'unknown';
            reject(new Error(`下载中断：${reason}`));
          }
        };
        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });
}

/* ---------------- 进度广播 ---------------- */

const progress = {
  active: false,
  phase: 'idle',       // idle | extract | images | markdown | done | error
  message: '',
  current: 0,
  total: 0,
  path: ''
};

function setProgress(patch) {
  Object.assign(progress, patch);
  // popup 可能已关闭，忽略发送失败
  chrome.runtime.sendMessage({ type: 'PROGRESS', progress: { ...progress } }).catch(() => {});
}

function toastToTab(tabId, text, isError = false) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type: 'SHOW_TOAST', text, isError }).catch(() => {});
}

/* ---------------- 保存编排 ---------------- */

let busy = false;

/**
 * 单篇文章保存核心流程（提取 → 图片下载 → Markdown/HTML 保存）。
 * @param {number} tabId   已加载完成的微信文章标签页
 * @param {object} settings 保存设置
 * @param {object} opts    { quiet: boolean } quiet 时不更新全局进度、不发页面 toast（批量模式）
 */
async function saveArticleCore(tabId, settings, opts = {}) {
  const quiet = !!opts.quiet;
  const prog = quiet ? () => {} : setProgress;
  const notify = quiet ? () => {} : toastToTab;

  try {
    /* 1. 提取文章 */
    prog({ active: true, phase: 'extract', message: '正在提取文章内容…', current: 0, total: 0, path: '' });

    let res;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_ARTICLE' });
    } catch (e) {
      throw new Error('无法与页面通信，请刷新文章页后重试');
    }
    if (!res || !res.ok) {
      throw new Error((res && res.error) || '提取文章失败');
    }

    let folderName = sanitizeName(res.title);
    const basePath = sanitizePath(settings.baseDir) || 'WeChatArticles';

    // Windows MAX_PATH（260）保护：相对路径部分（含文件名）控制在约 180 字符内
    const MAX_REL_LEN = 180;
    if (settings.perArticleFolder && basePath.length + folderName.length + 1 > MAX_REL_LEN) {
      folderName = folderName.slice(0, Math.max(10, MAX_REL_LEN - basePath.length - 1));
    }

    const folderPath = settings.perArticleFolder ? joinPath(basePath, folderName) : basePath;

    let markdown = res.markdown;
    let html = res.html || '';
    const images = res.images || [];

    /* 2. 处理图片
     *    Markdown 与 HTML 共用同一批本地图片：占位符 → images/xxx 相对路径
     *    （两个文件仍是独立文档，仅共享 images/ 目录，方便后续替换图片） */
    const urlToLocal = new Map(); // 相同 URL 只下载一次
    let failed = 0;

    if (settings.downloadImages && images.length > 0) {
      const total = images.length;
      for (let i = 0; i < total; i++) {
        const url = images[i];
        const marker = `${IMG_MARK}${i}@@`;
        prog({ phase: 'images', message: `下载图片 ${i + 1}/${total}`, current: i + 1, total });

        try {
          let localRel;
          if (urlToLocal.has(url)) {
            localRel = urlToLocal.get(url);
          } else {
            const ext = imageExtFromUrl(url);
            const relName = `images/${String(i + 1).padStart(3, '0')}.${ext}`;
            const actualPath = await downloadFile(url, joinPath(folderPath, relName));
            const baseName = actualPath.split(/[\\/]/).pop();
            localRel = joinPath('images', baseName);
            urlToLocal.set(url, localRel);
          }
          // 函数式替换，避免替换串中的 $ 被解释；Markdown 与 HTML 同步替换
          markdown = markdown.replace(marker, () => localRel);
          html = html.replace(marker, () => localRel);
        } catch (e) {
          failed++;
          console.warn('[微信文章转 Markdown] 图片下载失败，保留原链接:', url, e.message);
          markdown = markdown.replace(marker, () => url);
          html = html.replace(marker, () => url);
        }
      }
      if (failed > 0) {
        prog({ message: `图片下载完成（${failed} 张失败，保留原链接）` });
      }
    } else {
      // 不下载图片：占位符还原为原始 URL
      images.forEach((url, i) => {
        const marker = `${IMG_MARK}${i}@@`;
        markdown = markdown.replace(marker, () => url);
        html = html.replace(marker, () => url);
      });
    }

    /* 3. 保存 Markdown（引用本地 images/ 或原链接） */
    prog({ phase: 'markdown', message: '正在保存 Markdown…', current: images.length, total: images.length });
    const mdName = `${folderName}.md`;
    const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(markdown);
    const mdPath = await downloadFile(dataUrl, joinPath(folderPath, mdName));

    /* 4. 保存 HTML（可选，同样引用本地 images/ 相对路径） */
    if (settings.saveHtml && html) {
      prog({ phase: 'html', message: '正在保存 HTML…', current: images.length, total: images.length });
      const htmlDataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
      await downloadFile(htmlDataUrl, joinPath(folderPath, `${folderName}.html`));
    }

    const doneMsg = `已保存：${mdPath}${settings.saveHtml && html ? ' + HTML' : ''}`;
    prog({ active: false, phase: 'done', message: doneMsg, path: mdPath });
    notify(tabId, doneMsg);

    return { ok: true, path: mdPath };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    prog({ active: false, phase: 'error', message: msg });
    notify(tabId, '保存失败：' + msg, true);
    return { ok: false, error: msg };
  }
}

/** 单篇保存（当前活动标签页），带互斥锁与全局进度 */
async function saveArticle(tabId, settings) {
  if (busy) return { ok: false, error: '已有保存任务正在进行' };
  busy = true;
  try {
    return await saveArticleCore(tabId, settings, {});
  } finally {
    busy = false;
  }
}

/* ---------------- 批量队列 ---------------- */

const batch = {
  running: false,
  stopRequested: false,
  doneCount: 0,
  okCount: 0,
  failCount: 0,
  items: [] // { url, status: pending|saving|done|failed, message }
};

function broadcastBatchState() {
  chrome.runtime.sendMessage({ type: 'BATCH_STATE', batch: serializeBatch() }).catch(() => {});
}

function serializeBatch() {
  return {
    running: batch.running,
    stopRequested: batch.stopRequested,
    doneCount: batch.doneCount,
    okCount: batch.okCount,
    failCount: batch.failCount,
    items: batch.items.map((it) => ({ url: it.url, status: it.status, message: it.message || '' }))
  };
}

/** 从任意文本中解析微信文章 URL（去重、保持顺序） */
function parseUrlList(text) {
  const found = String(text || '').match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>)\]]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const u of found) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

/** 等待标签页加载完成（complete），带超时 */
function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('页面加载超时'));
    }, timeoutMs);

    const onUpdate = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        cleanup();
        resolve();
      }
    };
    const onRemoved = (id) => {
      if (id === tabId) {
        cleanup();
        reject(new Error('标签页被关闭'));
      }
    };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
    chrome.tabs.onRemoved.addListener(onRemoved);
    // 可能已经加载完成
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        cleanup();
        reject(new Error('标签页不存在'));
      } else if (tab.status === 'complete') {
        cleanup();
        resolve();
      }
    });
  });
}

/** 启动批量队列（同步校验后立即返回，队列在后台异步执行） */
function startBatch(urls) {
  if (busy || batch.running) return { ok: false, error: '已有保存任务正在进行' };
  // 去重并过滤（与 popup 侧 parseUrlList 保持纵深防御）
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean))];
  if (!list.length) return { ok: false, error: '未解析到有效的文章链接' };

  batch.items = list.map((url) => ({ url, status: 'pending', message: '' }));
  batch.running = true;
  batch.stopRequested = false;
  batch.doneCount = 0;
  batch.okCount = 0;
  batch.failCount = 0;
  busy = true;
  broadcastBatchState();

  runBatchLoop(); // fire-and-forget
  return { ok: true };
}

/** 批量队列执行：逐个访问 URL 并保存（后台标签页） */
async function runBatchLoop() {
  try {
    const settings = await getSettings();
    for (const item of batch.items) {
      if (batch.stopRequested) {
        item.status = 'failed';
        item.message = '已停止';
        batch.doneCount++;
        continue;
      }
      item.status = 'saving';
      item.message = '打开页面…';
      broadcastBatchState();

      let tab = null;
      try {
        tab = await chrome.tabs.create({ url: item.url, active: false });
        await waitForTabComplete(tab.id);
        item.message = '提取并保存…';
        broadcastBatchState();
        const res = await saveArticleCore(tab.id, settings, { quiet: true });
        if (res.ok) {
          item.status = 'done';
          item.message = res.path;
          batch.okCount++;
        } else {
          item.status = 'failed';
          item.message = res.error || '保存失败';
          batch.failCount++;
        }
      } catch (e) {
        item.status = 'failed';
        item.message = (e && e.message) || String(e);
        batch.failCount++;
      } finally {
        if (tab && tab.id != null) {
          chrome.tabs.remove(tab.id).catch(() => {});
        }
      }
      batch.doneCount++;
      broadcastBatchState();
    }
  } finally {
    batch.running = false;
    busy = false;
    broadcastBatchState();
  }
}

/* ---------------- 触发入口 ---------------- */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function handleSaveRequest() {
  if (batch.running) return { ok: false, error: '批量任务进行中，请稍候' };
  const tab = await getActiveTab();
  if (!tab || tab.id == null) {
    return { ok: false, error: '未找到活动标签页' };
  }
  const settings = await getSettings();
  return saveArticle(tab.id, settings);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'GET_SETTINGS') {
    getSettings().then((s) => sendResponse({ ok: true, settings: s }));
    return true; // async
  }

  if (msg.type === 'SET_SETTINGS') {
    saveSettings({ ...DEFAULT_SETTINGS, ...(msg.settings || {}) })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'SAVE_ARTICLE') {
    handleSaveRequest().then(sendResponse);
    return true;
  }

  if (msg.type === 'GET_PROGRESS') {
    sendResponse({ ok: true, progress: { ...progress } });
    return true;
  }

  if (msg.type === 'START_BATCH') {
    // startBatch 同步校验并立即返回，队列在后台异步执行
    sendResponse(startBatch(msg.urls));
    return true;
  }

  if (msg.type === 'STOP_BATCH') {
    batch.stopRequested = true;
    broadcastBatchState();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'CANCEL_BATCH') {
    if (batch.running) {
      sendResponse({ ok: false, error: '任务进行中，请先停止' });
      return true;
    }
    batch.items = [];
    batch.doneCount = batch.okCount = batch.failCount = 0;
    batch.stopRequested = false;
    broadcastBatchState();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_BATCH_STATE') {
    sendResponse({ ok: true, batch: serializeBatch() });
    return true;
  }
});

// 快捷键 Cmd/Ctrl+Shift+M：按已保存的设置直接保存
chrome.commands.onCommand.addListener((command) => {
  if (command === 'save-as-markdown') {
    handleSaveRequest();
  }
});
