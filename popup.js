/**
 * popup.js — 弹窗逻辑
 * popup.js — Popup logic
 *
 * 三个视图 Three views:
 *   - 设置 Settings：保存目录 / 独立文件夹 / 图片本地化 / 另存 HTML（含「保存设置」按钮）
 *     Save directory / per-article folder / local images / save-as-HTML
 *     (with an explicit "Save Settings" button).
 *   - 单篇保存 Single save：保存当前文章 + 实时进度
 *     Save the current article with live progress.
 *   - 批量导入 Batch import：URL 列表 / .txt 导入、逐条进度（失败置顶）、复制结果
 *     URL list / .txt import, per-item progress (failures on top), copy results.
 *
 * License: MIT — see LICENSE
 */

const $ = (sel) => document.querySelector(sel);

const baseDirInput = $('#baseDir');
const perArticleFolder = $('#perArticleFolder');
const downloadImages = $('#downloadImages');
const saveHtml = $('#saveHtml');
const pathPreview = $('#pathPreview');
const settingsSummaryEls = document.querySelectorAll('.settings-summary');
const saveBtn = $('#saveBtn');
const progressBox = $('#progressBox');
const progressText = $('#progressText');
const progressBar = $('#progressBar');
const statusBox = $('#statusBox');

/* ---------------- 设置 ---------------- */

function collectSettings() {
  return {
    baseDir: baseDirInput.value.trim() || 'WeChatArticles',
    perArticleFolder: perArticleFolder.checked,
    downloadImages: downloadImages.checked,
    saveHtml: saveHtml.checked
  };
}

// 与 background.js 保持一致的文件名清理（含 Windows 保留名处理，带扩展名也算保留名）
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f\u00ad\u180e\u200b-\u200f\u202a-\u202f\u2060-\u206f\ufeff\ufff9-\ufffb]/g;

function sanitizeName(name) {
  let s = String(name || '')
    .replace(INVISIBLE_CHARS, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .replace(/^[\s.]+/, '')
    .slice(0, 80);
  if (!s) return '未命名文章';
  if (WIN_RESERVED.test(s)) s = '_' + s;
  return s;
}

/** 规范化基础目录显示（与 background 一致） */
function normalizedBaseDir(baseDir) {
  return String(baseDir || '')
    .split(/[/\\]+/)
    .filter((seg) => seg.trim() && seg !== '.' && seg !== '..')
    .map(sanitizeName)
    .join('/')
    .slice(0, 120)
    .replace(/[.\s]+$/, '') || 'WeChatArticles';
}

function renderPreview() {
  const s = collectSettings();
  const base = normalizedBaseDir(s.baseDir);
  const lines = [];
  if (s.perArticleFolder) {
    lines.push(`📁 下载/${base}/<文章标题>/`);
    if (s.downloadImages) lines.push('　　🖼 images/001.jpg …');
    lines.push('　　📄 <文章标题>.md');
    if (s.saveHtml) lines.push('　　🌐 <文章标题>.html');
  } else {
    lines.push(`📁 下载/${base}/`);
    if (s.downloadImages) lines.push('　　🖼 images/001.jpg …（多篇文章共用，文件名可能加序号）');
    lines.push('　　📄 <文章标题>.md');
    if (s.saveHtml) lines.push('　　🌐 <文章标题>.html');
  }
  pathPreview.textContent = lines.join('\n');
  renderSettingsSummary(s);
}

/** 单篇/批量视图顶部的当前设置摘要 */
function renderSettingsSummary(s) {
  const cfg = s || collectSettings();
  const base = normalizedBaseDir(cfg.baseDir);
  const parts = [
    `📁 下载/${base}`,
    cfg.perArticleFolder ? '· 每篇独立文件夹' : '· 共用文件夹',
    cfg.downloadImages ? '· 图片存 images/' : '· 图片保留原链接',
    cfg.saveHtml ? '· 另存 HTML' : '· 仅 Markdown'
  ];
  const text = parts.join(' ') + '　（可在「设置」页修改）';
  settingsSummaryEls.forEach((el) => { el.textContent = text; });
}

async function loadSettings() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (res && res.ok && res.settings) {
    baseDirInput.value = res.settings.baseDir;
    perArticleFolder.checked = !!res.settings.perArticleFolder;
    downloadImages.checked = !!res.settings.downloadImages;
    saveHtml.checked = res.settings.saveHtml !== false;
  }
  renderPreview();
}

async function persistSettings() {
  await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: collectSettings() });
}

/* ---------------- 进度 ---------------- */

function showProgress(p) {
  if (!p) return;
  const running = p.active && ['extract', 'images', 'markdown', 'html'].includes(p.phase);
  progressBox.hidden = !running;
  if (running) {
    progressText.textContent = p.message || '处理中…';
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 8;
    progressBar.style.width = pct + '%';
  }
}

function showStatus(text, isError) {
  statusBox.hidden = false;
  statusBox.className = 'status ' + (isError ? 'err' : 'ok');
  statusBox.textContent = text;
}

function setSavingUI(saving) {
  saveBtn.disabled = saving;
  saveBtn.textContent = saving ? '保存中…' : '保存当前文章';
}

/* ---------------- 保存 ---------------- */

async function doSave() {
  await persistSettings();
  setSavingUI(true);
  statusBox.hidden = true;

  const res = await chrome.runtime.sendMessage({ type: 'SAVE_ARTICLE' });

  setSavingUI(false);
  progressBox.hidden = true;

  if (res && res.ok) {
    showStatus('✅ 保存成功：' + res.path, false);
  } else {
    showStatus('❌ ' + ((res && res.error) || '保存失败'), true);
  }
}

/* ---------------- 视图切换（设置 / 单篇保存 / 批量导入） ---------------- */

const tabBtns = document.querySelectorAll('.tab');
const views = {
  settings: $('#view-settings'),
  single: $('#view-single'),
  batch: $('#view-batch')
};

function switchView(name) {
  tabBtns.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  for (const key of Object.keys(views)) {
    views[key].hidden = key !== name;
  }
  // 切到执行页时刷新设置摘要
  if (name !== 'settings') renderSettingsSummary();
}

tabBtns.forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------------- 批量导入 ---------------- */

const urlInput = $('#urlInput');
const urlCount = $('#urlCount');
const importFileBtn = $('#importFileBtn');
const fileInput = $('#fileInput');
const batchStartBtn = $('#batchStartBtn');
const batchStopBtn = $('#batchStopBtn');
const batchSummary = $('#batchSummary');
const batchSummaryText = $('#batchSummaryText');
const copyResultBtn = $('#copyResultBtn');
const batchList = $('#batchList');

// 与 background.js 保持一致的 URL 解析
function parseUrlList(text) {
  const found = String(text || '').match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s"'<>)\]]+/g) || [];
  return [...new Set(found)];
}

function updateUrlCount() {
  const n = parseUrlList(urlInput.value).length;
  urlCount.textContent = `${n} 个链接`;
}

const STATUS_TEXT = {
  pending: '等待',
  saving: '保存中…',
  done: '完成',
  failed: '失败'
};

/** 最近一次渲染的批量状态（供复制按钮使用） */
let lastBatchState = null;

function renderBatch(state) {
  if (!state) return;
  lastBatchState = state;
  batchStartBtn.hidden = state.running;
  batchStopBtn.hidden = !state.running;
  batchStartBtn.disabled = state.running;

  const items = state.items || [];
  // 失败项置顶，其余保持原顺序（稳定）
  const sortedItems = [...items].sort((a, b) => {
    return (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1);
  });

  batchList.innerHTML = '';
  for (const it of sortedItems) {
    const li = document.createElement('li');
    li.dataset.status = it.status;
    const urlSpan = document.createElement('span');
    urlSpan.className = 'b-url';
    urlSpan.textContent = it.url;
    urlSpan.title = it.message || it.url;
    const stSpan = document.createElement('span');
    stSpan.className = 'b-status';
    stSpan.textContent = STATUS_TEXT[it.status] || it.status;
    li.appendChild(urlSpan);
    li.appendChild(stSpan);
    batchList.appendChild(li);
  }

  if (items.length > 0) {
    batchSummary.hidden = false;
    copyResultBtn.hidden = false;
    const stat = state.running ? '进行中' : (state.stopRequested ? '已停止' : '已完成');
    batchSummaryText.textContent =
      `${stat} · ${state.doneCount}/${items.length}` +
      ` · ✅ ${state.okCount} · ❌ ${state.failCount}`;
  } else {
    batchSummary.hidden = true;
    copyResultBtn.hidden = true;
  }
}

/** 生成批量结果报告文本（失败在前） */
function buildBatchReport(state) {
  const items = state.items || [];
  const sorted = [...items].sort((a, b) => {
    return (a.status === 'failed' ? 0 : 1) - (b.status === 'failed' ? 0 : 1);
  });
  const header = `批量保存结果：共 ${items.length} 篇 · ✅ ${state.okCount} · ❌ ${state.failCount}`;
  const lines = sorted.map((it) => {
    const icon = it.status === 'done' ? '✅' : (it.status === 'failed' ? '❌' : '⏳');
    return `${icon} ${it.url}${it.message ? ' — ' + it.message : ''}`;
  });
  return header + '\n' + lines.join('\n');
}

/** 复制文本到剪贴板（Clipboard API 失败时降级 execCommand） */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

async function startBatch() {
  const urls = parseUrlList(urlInput.value);
  if (!urls.length) {
    alert('未解析到有效的微信文章链接（mp.weixin.qq.com/s/...）');
    return;
  }
  if (!confirm(`即将自动访问并保存 ${urls.length} 篇文章，确认继续？`)) return;
  await persistSettings(); // 确保使用最新设置
  batchStartBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'START_BATCH', urls });
  if (!res || !res.ok) {
    alert((res && res.error) || '启动批量任务失败');
    batchStartBtn.disabled = false;
  }
  const st = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
  if (st && st.ok) renderBatch(st.batch);
}

/* ---------------- 事件绑定 ---------------- */

saveBtn.addEventListener('click', doSave);
[baseDirInput, perArticleFolder, downloadImages, saveHtml].forEach((el) => {
  el.addEventListener('change', () => {
    renderPreview();
    persistSettings(); // 修改即时保存（保存按钮作为显式确认）
    showSettingsTip(''); // 清除上次的保存提示
  });
});
baseDirInput.addEventListener('input', renderPreview);

// 设置页「保存设置」按钮
const saveSettingsBtn = $('#saveSettingsBtn');
const saveSettingsTip = $('#saveSettingsTip');

function showSettingsTip(text, isError) {
  saveSettingsTip.textContent = text;
  saveSettingsTip.className = 'save-settings-tip' + (isError ? ' err' : '');
}

saveSettingsBtn.addEventListener('click', async () => {
  saveSettingsBtn.disabled = true;
  showSettingsTip('保存中…', false);
  try {
    await persistSettings();
    renderPreview();
    showSettingsTip('✅ 设置已保存', false);
  } catch (e) {
    showSettingsTip('❌ 保存失败：' + ((e && e.message) || e), true);
  } finally {
    saveSettingsBtn.disabled = false;
  }
});

// 批量导入事件
urlInput.addEventListener('input', updateUrlCount);
importFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = parseUrlList(text);
    if (!parsed.length) {
      alert('文件中未解析到有效的微信文章链接');
    } else {
      // 追加到输入框（保持已有内容）
      const existing = urlInput.value.trim();
      urlInput.value = (existing ? existing + '\n' : '') + parsed.join('\n');
      updateUrlCount();
    }
  } catch (e) {
    alert('读取文件失败：' + e.message);
  } finally {
    fileInput.value = '';
  }
});
batchStartBtn.addEventListener('click', startBatch);
batchStopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_BATCH' });
  batchStopBtn.textContent = '正在停止…';
  batchStopBtn.disabled = true;
});

// 一键复制批量结果到剪贴板（失败项在前）
copyResultBtn.addEventListener('click', async () => {
  if (!lastBatchState) return;
  const text = buildBatchReport(lastBatchState);
  const ok = await copyText(text);
  const old = copyResultBtn.textContent;
  copyResultBtn.textContent = ok ? '✅ 已复制' : '复制失败';
  copyResultBtn.disabled = true;
  setTimeout(() => {
    copyResultBtn.textContent = old;
    copyResultBtn.disabled = false;
  }, 1500);
});

// 监听 background 广播的进度 / 批量状态
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'PROGRESS') {
    showProgress(msg.progress);
    if (!msg.progress.active && msg.progress.phase === 'done') {
      // 快捷键等外部触发的完成事件
      setSavingUI(false);
      showStatus('✅ 保存成功：' + msg.progress.path, false);
    } else if (!msg.progress.active && msg.progress.phase === 'error') {
      setSavingUI(false);
      showStatus('❌ ' + msg.progress.message, true);
    }
  } else if (msg.type === 'BATCH_STATE') {
    renderBatch(msg.batch);
    if (!msg.batch.running) {
      batchStopBtn.textContent = '停止';
      batchStopBtn.disabled = false;
    }
  }
});

// 恢复 popup 打开前正在进行的任务状态
(async () => {
  await loadSettings();
  updateUrlCount();

  const res = await chrome.runtime.sendMessage({ type: 'GET_PROGRESS' });
  if (res && res.ok && res.progress) {
    const p = res.progress;
    if (p.active) {
      setSavingUI(true);
      showProgress(p);
    } else if (p.phase === 'done' && p.path) {
      showStatus('✅ 上次保存成功：' + p.path, false);
    } else if (p.phase === 'error') {
      showStatus('❌ ' + p.message, true);
    }
  }

  const st = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
  if (st && st.ok && st.batch) {
    renderBatch(st.batch);
    if (st.batch.running) switchView('batch'); // 有进行中的批量任务时切到批量视图
  }
})();
