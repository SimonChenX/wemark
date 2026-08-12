#!/usr/bin/env node
/**
 * 批量导入流程单元测试：用最小化的 chrome API mock 加载 background.js，验证：
 * Unit tests for the batch import flow. Loads background.js with a minimal
 * chrome API mock and verifies:
 *  1. URL 列表解析与去重（经 START_BATCH 入口生效）
 *     URL list parsing & deduplication (via the START_BATCH entry point).
 *  2. 队列状态机：pending → saving → done/failed、计数、广播
 *     Queue state machine: pending → saving → done/failed, counters, broadcast.
 *  3. STOP_BATCH 停止语义：剩余任务标记失败
 *     STOP_BATCH semantics: remaining tasks are marked failed.
 *  4. 单篇保存互斥（busy 锁）
 *     Single-save mutual exclusion (the busy lock).
 *
 * License: MIT — see ../LICENSE
 */

/* ---- mock chrome 环境 ---- */
const messageListeners = [];
const commandListeners = [];
const tabUpdateListeners = [];
const tabRemoveListeners = [];

const downloadedFiles = []; // 记录 downloadFile 调用
const createdTabs = [];
const removedTabs = [];
const sentMessages = [];
const downloadChangedListeners = [];

let tabIdSeq = 100;

const chromeMock = {
  runtime: {
    lastError: null,
    sendMessage: async (msg) => { sentMessages.push(msg); return {}; },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onCommand: undefined
  },
  commands: { onCommand: { addListener: (fn) => commandListeners.push(fn) } },
  storage: {
    sync: {
      get: async (defaults) => ({ ...defaults }),
      set: async () => {}
    }
  },
  downloads: {
    download: (opts, cb) => {
      downloadedFiles.push(opts.filename);
      const id = downloadedFiles.length;
      setTimeout(() => {
        for (const l of downloadChangedListeners.slice()) {
          l({ id, state: { current: 'complete' } });
        }
      }, 0);
      cb(id);
      return undefined;
    },
    onChanged: {
      addListener: (fn) => downloadChangedListeners.push(fn),
      removeListener: (fn) => {
        const i = downloadChangedListeners.indexOf(fn);
        if (i >= 0) downloadChangedListeners.splice(i, 1);
      }
    },
    search: (q, cb) => cb([{ id: q.id, filename: '/tmp/downloads/' + q.id + '_' + (downloadedFiles[q.id - 1] || '') }])
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://mp.weixin.qq.com/s/current' }],
    create: async (opts) => {
      const tab = { id: ++tabIdSeq, url: opts.url, status: 'loading' };
      createdTabs.push(tab);
      // 模拟异步加载完成（60ms/页，保证 STOP 能打断队列）
      setTimeout(() => {
        tab.status = 'complete';
        for (const l of tabUpdateListeners) l(tab.id, { status: 'complete' });
      }, 60);
      return tab;
    },
    remove: async (id) => { removedTabs.push(id); },
    get: (id, cb) => {
      const t = createdTabs.find((x) => x.id === id);
      cb(t || { id, status: 'loading' });
    },
    sendMessage: async (tabId, msg) => {
      // 模拟 content script 返回提取结果
      if (msg.type === 'EXTRACT_ARTICLE') {
        return {
          ok: true,
          title: '批量测试文章' + tabId,
          markdown: '# 标题\n\n正文 @@WXIMG@@0@@\n',
          html: '<img src="@@WXIMG@@0@@">',
          images: []
        };
      }
      return { ok: true };
    },
    onUpdated: { addListener: (fn) => tabUpdateListeners.push(fn), removeListener: () => {} },
    onRemoved: { addListener: (fn) => tabRemoveListeners.push(fn), removeListener: () => {} }
  }
};

globalThis.chrome = chromeMock;
globalThis.self = globalThis;

/* ---- 加载 background.js ---- */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const code = fs.readFileSync(path.join(root, 'background.js'), 'utf-8');
vm.runInThisContext(code, { filename: 'background.js' });

console.log('[test] background.js 加载成功，消息监听器数:', messageListeners.length);
if (messageListeners.length === 0) {
  console.error('[test] 失败：未注册消息监听器');
  process.exit(1);
}

const listener = messageListeners[0];
function send(msg) {
  return new Promise((resolve) => listener(msg, {}, resolve));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 测试 1：URL 解析（通过 START_BATCH + GET_BATCH_STATE 间接验证） ---- */
const urls = [
  'https://mp.weixin.qq.com/s/AAA',
  'https://mp.weixin.qq.com/s/BBB',
  'https://mp.weixin.qq.com/s/AAA',   // 重复，应去重
  'https://example.com/not-wechat',    // 非微信链接，应在 popup 侧过滤（background 侧会尝试，这里测队列）
];
const wechatUrls = urls.slice(0, 3); // 去重后 2 个

const startRes = await send({ type: 'START_BATCH', urls: wechatUrls });
console.log('[test] START_BATCH 返回:', JSON.stringify(startRes));
if (!startRes.ok) { console.error('[test] 失败：启动批量任务被拒绝'); process.exit(2); }

// 等待批量任务跑完（2 篇文章，每篇模拟 5ms 加载 + 下载事件）
await sleep(800);

const state1 = await send({ type: 'GET_BATCH_STATE' });
const b = state1.batch;
console.log('[test] 批量状态:', JSON.stringify({ running: b.running, done: b.doneCount, ok: b.okCount, fail: b.failCount, items: b.items.map((i) => i.status) }));

if (b.running) { console.error('[test] 失败：批量任务未结束'); process.exit(3); }
if (b.items.length !== 2) { console.error('[test] 失败：URL 去重未生效，期望 2 项，实际', b.items.length); process.exit(4); }
if (b.okCount !== 2 || b.failCount !== 0) { console.error('[test] 失败：成功/失败计数异常'); process.exit(5); }
if (!b.items.every((i) => i.status === 'done')) { console.error('[test] 失败：存在未完成项'); process.exit(6); }
if (removedTabs.length !== 2) { console.error('[test] 失败：后台标签页未关闭，实际关闭', removedTabs.length); process.exit(7); }

console.log('[test] 下载的文件样例:', downloadedFiles.slice(0, 4));
const hasMd = downloadedFiles.some((f) => f.endsWith('.md'));
const hasHtml = downloadedFiles.some((f) => f.endsWith('.html'));
if (!hasMd || !hasHtml) { console.error('[test] 失败：未生成 md/html 下载任务', { hasMd, hasHtml }); process.exit(8); }

/* ---- 测试 2：STOP_BATCH 停止语义 ---- */
const urls2 = Array.from({ length: 5 }, (_, i) => `https://mp.weixin.qq.com/s/STOP${i}`);
await send({ type: 'START_BATCH', urls: urls2 });
await sleep(90); // 第 1 篇加载完成并保存中（每页 60ms 加载）
await send({ type: 'STOP_BATCH' });
await sleep(1200);

const state2 = await send({ type: 'GET_BATCH_STATE' });
const b2 = state2.batch;
console.log('[test] 停止后状态:', JSON.stringify({ running: b2.running, done: b2.doneCount, ok: b2.okCount, fail: b2.failCount }));
if (b2.running) { console.error('[test] 失败：停止后仍在运行'); process.exit(9); }
const stoppedCount = b2.items.filter((i) => i.message === '已停止').length;
if (stoppedCount === 0) { console.error('[test] 失败：停止未标记剩余任务'); process.exit(10); }

/* ---- 测试 3：互斥锁（批量进行中拒绝新任务） ---- */
await send({ type: 'START_BATCH', urls: ['https://mp.weixin.qq.com/s/LOCK1', 'https://mp.weixin.qq.com/s/LOCK2'] });
await sleep(20);
const dupRes = await send({ type: 'START_BATCH', urls: ['https://mp.weixin.qq.com/s/DUP'] });
console.log('[test] 重复启动返回:', JSON.stringify(dupRes));
if (dupRes.ok) { console.error('[test] 失败：批量进行中未拒绝新任务'); process.exit(11); }
const singleRes = await send({ type: 'SAVE_ARTICLE' });
console.log('[test] 批量期间单篇保存返回:', JSON.stringify(singleRes));
if (singleRes.ok) { console.error('[test] 失败：批量进行中未拒绝单篇保存'); process.exit(12); }
await sleep(600);

console.log('[test] 全部通过 ✅');
process.exit(0);
