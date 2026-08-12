#!/usr/bin/env node
/**
 * 本地集成测试：用 jsdom 模拟浏览器环境，验证：
 * Local integration test: simulates a browser environment with jsdom to verify:
 *  1. content.js 的 EXTRACT_ARTICLE 消息流程（标题 + 占位符 Markdown/HTML + 图片列表）
 *     The EXTRACT_ARTICLE message flow in content.js
 *     (title + placeholder Markdown/HTML + image list).
 *  2. background.js 的图片占位符替换与路径编排逻辑（下载 API 打桩模拟）
 *     Placeholder replacement & path orchestration logic from background.js
 *     (download API is stubbed/simulated).
 *
 * 用法 Usage:
 *   node tools/test_local.mjs <微信文章HTML文件 / saved article .html> [输出md路径 / output .md path]
 *
 * 依赖 Dependency: jsdom（默认查找 /tmp/wx-md-test/node_modules，可用 NODE_MODULES 环境变量覆盖）
 *   jsdom (defaults to /tmp/wx-md-test/node_modules, override with NODE_MODULES env var)
 *
 * License: MIT — see ../LICENSE
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const htmlFile = process.argv[2];
const outFile = process.argv[3] || '/tmp/wx_test_output.md';
if (!htmlFile) {
  console.error('用法: node tools/test_local.mjs <article.html> [out.md]');
  process.exit(1);
}

/* ---- 加载 jsdom ---- */
const candidates = [
  process.env.NODE_MODULES,
  '/tmp/wx-md-test/node_modules',
  path.resolve('node_modules')
].filter(Boolean);
let JSDOM = null;
for (const dir of candidates) {
  try {
    const mod = await import(pathToFileURL(path.join(dir, 'jsdom', 'lib', 'api.js')).href)
      .catch(() => import(pathToFileURL(path.join(dir, 'jsdom')).href));
    JSDOM = mod.JSDOM || (mod.default && mod.default.JSDOM);
    if (JSDOM) { console.log('[test] 使用 jsdom 来自', dir); break; }
  } catch (e) { /* try next */ }
}
if (!JSDOM) {
  console.error('[test] 未找到 jsdom，请先安装：npm i jsdom');
  process.exit(1);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(htmlFile, 'utf-8');

const dom = new JSDOM(html, {
  url: 'https://mp.weixin.qq.com/s/k8VCMkhyYgmUTsVi3VrhKQ',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;

/* ---- 模拟 Chrome 扩展环境 ---- */
let messageHandler = null;
window.chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { messageHandler = fn; } },
    sendMessage: async () => {},
    lastError: null
  }
};

/* ---- 依次注入 content script 依赖 ---- */
for (const rel of ['lib/turndown.js', 'lib/turndown-plugin-gfm.js', 'content.js']) {
  try {
    window.eval(fs.readFileSync(path.join(root, rel), 'utf-8'));
    console.log('[test] 注入成功:', rel);
  } catch (e) {
    console.error('[test] 注入失败:', rel, e.message);
    process.exit(2);
  }
}
if (!messageHandler) {
  console.error('[test] content.js 未注册消息监听器');
  process.exit(3);
}

/* ---- 1) 触发 EXTRACT_ARTICLE ---- */
let extractRes = null;
messageHandler({ type: 'EXTRACT_ARTICLE' }, {}, (res) => { extractRes = res; });

if (!extractRes || !extractRes.ok) {
  console.error('[test] 提取失败:', extractRes);
  process.exit(4);
}
console.log('[test] 提取成功:', JSON.stringify({
  title: extractRes.title,
  markdownLength: extractRes.markdown.length,
  htmlLength: (extractRes.html || '').length,
  imageCount: extractRes.images.length
}));

/* ---- 2) 模拟 background 的图片下载与占位符替换 ---- */
const IMG_MARK = '@@WXIMG@@';
const settings = { baseDir: 'WeChatArticles', perArticleFolder: true, downloadImages: true };
const downloads = []; // 记录 background 会发起的下载任务

function sanitizeName(name) {
  let s = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '')
    .slice(0, 80);
  return s || '未命名文章';
}
function imageExtFromUrl(url) {
  const m = String(url).match(/wx_fmt=([a-z0-9]+)/i);
  if (m && ['png', 'gif', 'webp', 'bmp', 'jpeg', 'jpg'].includes(m[1].toLowerCase())) {
    return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  }
  return 'jpg';
}

const folderName = sanitizeName(extractRes.title);
const basePath = settings.baseDir.split(/[/\\]+/).map(sanitizeName).filter(Boolean).join('/');
const folderPath = settings.perArticleFolder ? `${basePath}/${folderName}` : basePath;

// Markdown 与 HTML：占位符 → 同一批 images/ 本地相对路径（模拟 background 同步替换）
let markdown = extractRes.markdown;
let htmlOut = extractRes.html || '';
const urlToLocal = new Map();
extractRes.images.forEach((url, i) => {
  const marker = `${IMG_MARK}${i}@@`;
  let localRel;
  if (urlToLocal.has(url)) {
    localRel = urlToLocal.get(url);
  } else {
    localRel = `images/${String(i + 1).padStart(3, '0')}.${imageExtFromUrl(url)}`;
    urlToLocal.set(url, localRel);
    downloads.push({ url, filename: `${folderPath}/${localRel}` });
  }
  markdown = markdown.replace(marker, () => localRel);
  htmlOut = htmlOut.replace(marker, () => localRel);
});

/* ---- 3) 校验结果：两文件独立（共享 images/ 目录） ---- */
const leftover = (markdown.match(/@@WXIMG@@/g) || []).length + (htmlOut.match(/@@WXIMG@@/g) || []).length;
const mdLocalRefs = (markdown.match(/!\[[^\]]*\]\(images\/\d{3}\.\w+\)/g) || []).length;
const htmlLocalRefs = (htmlOut.match(/src="images\/\d{3}\.\w+"/g) || []).length;
const htmlExternal = (htmlOut.match(/src="https?:\/\//g) || []).length; // 本地化后应为 0
const htmlValid = htmlOut.startsWith('<!DOCTYPE html>') && htmlOut.includes('</html>');
const heading = markdown.split('\n').slice(0, 8).join('\n');

console.log('----- 双文件编排模拟结果（共享 images/） -----');
console.log('文件夹路径  : 下载/' + folderPath);
console.log('图片下载任务:', downloads.length, '张（去重后，MD/HTML 共用）');
console.log('MD 本地图片引用  :', mdLocalRefs);
console.log('HTML 本地图片引用:', htmlLocalRefs);
console.log('HTML 外链残留   :', htmlExternal, '（应为 0）');
console.log('HTML结构完整:', htmlValid);
console.log('残留占位符  :', leftover);
console.log('Markdown头部预览:');
console.log(heading);

fs.writeFileSync(outFile, markdown, 'utf-8');
fs.writeFileSync(outFile.replace(/\.md$/, '.html'), htmlOut, 'utf-8');
console.log('输出文件    :', outFile, '+ 同名 .html（引用共享 images/）');

if (leftover > 0) {
  console.error('[test] 失败：存在未替换的占位符');
  process.exit(5);
}
if (!htmlValid || htmlLocalRefs !== mdLocalRefs || htmlExternal > 0) {
  console.error('[test] 失败：HTML 本地图片引用校验未通过');
  process.exit(6);
}
console.log('[test] 全部通过 ✅');
process.exit(0);
