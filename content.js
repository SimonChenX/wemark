/**
 * content.js — 微信文章提取与 Markdown / HTML 转换
 * content.js — WeChat article extraction and Markdown / HTML conversion
 *
 * 运行于 mp.weixin.qq.com 页面的隔离环境（isolated world）。
 * Runs inside the isolated world of mp.weixin.qq.com pages.
 *
 * 依赖 Dependencies:
 *   - lib/turndown.js            （全局 TurndownService / global TurndownService）
 *   - lib/turndown-plugin-gfm.js （exports.gfm，表格/删除线等 GFM 语法 / tables, strikethrough, etc.）
 *
 * 消息协议 Message protocol（由 background.js 驱动 / driven by background.js）:
 *   - EXTRACT_ARTICLE → 返回 { ok, title, markdown, html, images[] }
 *     Returns { ok, title, markdown, html, images[] }.
 *     图片以占位符 @@WXIMG@@序号@@ 标记，由 background 下载图片后替换为本地相对路径。
 *     Images are marked with the placeholder @@WXIMG@@index@@, which background.js
 *     replaces with local relative paths after downloading.
 *   - SHOW_TOAST → 在页面显示结果提示（快捷键保存时的反馈）
 *     Shows an in-page toast (feedback when saving via the keyboard shortcut).
 *
 * License: MIT — see LICENSE
 */

(() => {
  // 防止扩展热重载时重复注入监听器
  if (window.__wxMarkdownExtLoaded) return;
  window.__wxMarkdownExtLoaded = true;

  /** 图片占位符标记，供 background 替换 */
  const IMG_MARK = '@@WXIMG@@';

  /* ---------------- 元信息提取 ---------------- */

  const textOf = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : '';
  };

  const metaContent = (property) => {
    const el =
      document.querySelector(`meta[property="${property}"]`) ||
      document.querySelector(`meta[name="${property}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };

  /**
   * 从页面内联脚本中提取发布时间的兜底方案。
   * 微信文章源码里通常带有：
   *   createTime = '2019-09-28 17:30'
   *   var ct = "1569663000" / var create_time = "..." * 1
   */
  function publishTimeFromSource() {
    try {
      const html = document.documentElement.outerHTML;
      const pad = (n) => String(n).padStart(2, '0');

      let m = html.match(/createTime\s*=\s*'([^']+)'/);
      if (m && m[1].trim()) return m[1].trim();

      m = html.match(/(?:var\s+)?(?:ct|create_time)\s*=\s*["'](\d{9,11})["']/);
      if (m) {
        const d = new Date(parseInt(m[1], 10) * 1000);
        if (!isNaN(d.getTime())) {
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
            `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      }
    } catch (e) { /* 忽略解析错误 */ }
    return '';
  }

  function getArticleMeta() {
    let title =
      textOf('#activity-name') ||
      metaContent('og:title') ||
      metaContent('twitter:title') ||
      document.title.replace(/\s*[-|]\s*微信公众号\s*$/, '').trim() ||
      '微信文章';

    const account =
      textOf('#js_name') ||
      metaContent('og:article:author') ||
      metaContent('author');

    const author = textOf('#js_author_name') || textOf('#js_name');

    const publishTime =
      textOf('#publish_time') ||
      metaContent('article:published_time') ||
      metaContent('publish_time') ||
      publishTimeFromSource();

    return { title, account, author, publishTime, url: location.href };
  }

  /* ---------------- 正文清理 ---------------- */

  /**
   * 克隆正文节点并做清理：
   * - 懒加载图片 data-src / data-original → src（微信正文图片均为懒加载）
   * - 移除脚本、样式、二维码、点赞区等非正文节点
   * - 移除隐藏元素
   */
  function prepareContentNode() {
    const source =
      document.querySelector('#js_content') ||
      document.querySelector('.rich_media_content') ||
      document.querySelector('article') ||
      document.body;

    const clone = source.cloneNode(true);

    // 移除无用节点
    const junkSelector = [
      'script', 'style', 'link', 'iframe.frame_music',
      '#js_pc_qr_code', '.qr_code_pc', '.qr_code_pc_outer',
      '.reward_area', '#js_reward_area', '.like_area', '.read_more_area',
      'mp-action-bar', '#content_bottom_area', '#js_temp_bottom_area',
      '.wx_profile_card_inner', '.wx_tap_translate'
    ].join(',');
    clone.querySelectorAll(junkSelector).forEach((n) => n.remove());

    // 移除隐藏元素（含媒体内容的隐藏节点保留：微信常用 visibility:hidden 包裹懒加载图片容器）
    const hasMedia = (n) => !!n.querySelector('img, video, audio, iframe, mpvideosnap');
    clone.querySelectorAll('[hidden]').forEach((n) => {
      if (!hasMedia(n)) n.remove();
    });
    clone.querySelectorAll('[style]').forEach((n) => {
      const s = n.getAttribute('style') || '';
      if (!/display\s*:\s*none|visibility\s*:\s*hidden/i.test(s)) return;
      if (hasMedia(n)) {
        n.removeAttribute('style'); // 保留媒体，仅去掉隐藏样式
        return;
      }
      n.remove();
    });

    // 处理懒加载图片
    clone.querySelectorAll('img').forEach((img) => {
      const real =
        img.getAttribute('data-src') ||
        img.getAttribute('data-original') ||
        img.getAttribute('data-actualsrc') ||
        '';
      if (real) img.setAttribute('src', real);

      const src = img.getAttribute('src') || '';
      // 协议相对地址补全
      if (src.startsWith('//')) img.setAttribute('src', 'https:' + src);

      // 清理微信私有属性，保留 alt/width/height
      [...img.attributes].forEach((attr) => {
        if (!['src', 'alt', 'title', 'width', 'height'].includes(attr.name)) {
          img.removeAttribute(attr.name);
        }
      });

      // 无有效 src 的占位图直接移除
      if (!img.getAttribute('src')) img.remove();
    });

    return clone;
  }

  /* ---------------- Markdown 转换 ---------------- */

  /**
   * 构建 Turndown 实例。
   * img 的 src 在调用前已被替换为占位符，规则直接透传。
   */
  function buildTurndown() {
    const td = new TurndownService({
      headingStyle: 'atx',          // # 标题
      hr: '---',
      bulletListMarker: '-',
      codeBlockStyle: 'fenced',     // ``` 代码块
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined'
    });

    // GFM：表格、删除线、任务列表、高亮代码块
    if (typeof exports !== 'undefined' && exports.gfm) {
      td.use(exports.gfm);
    }

    // 图片：src 已是占位符（@@WXIMG@@序号@@），直接透传
    td.addRule('wxImage', {
      filter: 'img',
      replacement: (content, node) => {
        const src = node.getAttribute('src') || '';
        if (!src) return '';
        const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
        return `\n\n![${alt}](${src})\n\n`;
      }
    });

    // 空节点（无文字、无图片）直接丢弃，避免产生大量空行
    td.addRule('emptyBlock', {
      filter: (node) => {
        if (node.nodeType !== 1) return false;
        const tag = node.nodeName;
        if (['BR', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME'].includes(tag)) return false;
        if (node.querySelector && node.querySelector('img, video, audio, iframe, mpvideosnap')) return false;
        return (node.textContent || '').replace(/\u00a0/g, '').trim() === '';
      },
      replacement: () => ''
    });

    // 微信视频占位 <mpvideosnap>
    td.addRule('wxVideoSnap', {
      filter: (node) => node.nodeName === 'MPVIDEOSNAP',
      replacement: (content, node) => {
        const desc = node.getAttribute('data-desc') || node.getAttribute('data-nickname') || '';
        const src = node.getAttribute('data-src') || node.getAttribute('data-url') || '';
        const label = desc ? `🎬 视频：${desc}` : '🎬 视频（微信内嵌内容）';
        return src ? `\n\n[${label}](${src})\n\n` : `\n\n> ${label}\n\n`;
      }
    });

    // 微信音频 <mpvoice>
    td.addRule('wxVoice', {
      filter: (node) => node.nodeName === 'MPVOICE',
      replacement: (content, node) => {
        const name = node.getAttribute('name') || node.getAttribute('data-name') || '';
        return `\n\n> 🎧 音频${name ? '：' + name : ''}（微信内嵌内容，请在原文收听）\n\n`;
      }
    });

    // 小程序卡片等自定义组件
    td.addRule('wxCustomTag', {
      filter: (node) => /^MP-[A-Z-]+$/.test(node.nodeName),
      replacement: (content) => {
        const text = (content || '').trim();
        return text ? `\n\n${text}\n\n` : '';
      }
    });

    // iframe（多为腾讯视频外链）
    td.addRule('iframe', {
      filter: 'iframe',
      replacement: (content, node) => {
        const src = node.getAttribute('data-src') || node.getAttribute('src') || '';
        return src ? `\n\n> 🎬 视频：${src}\n\n` : '';
      }
    });

    // 保留 <figure> 语义：图注以斜体呈现
    td.addRule('figcaption', {
      filter: 'figcaption',
      replacement: (content) => (content.trim() ? `\n\n*${content.trim()}*\n\n` : '')
    });

    return td;
  }

  // HTML 转义（用 \x 拼接实体串，避免被中间环节解码）
  const ESC = {
    '&': '\x26' + 'amp;',
    '<': '\x3c' + 'lt;',
    '>': '\x3e' + 'gt;',
    '"': '\x22' + 'quot;',
    "'": '\x27' + '#39;'
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

  /** 生成独立的 HTML 文档模板（正文 img src 已是占位符） */
  function buildHtmlTemplate(meta, bodyHtml) {
    const title = escapeHtml(meta.title);
    const metaLine = meta.publishTime
      ? `<p class="meta">发布时间：${escapeHtml(meta.publishTime)}</p>`
      : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  body { margin: 0; padding: 24px 16px; background: #f5f5f5;
         font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
  article { max-width: 760px; margin: 0 auto; background: #fff; padding: 32px 28px;
            border-radius: 8px; line-height: 1.8; color: #333; font-size: 16px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { color: #999; font-size: 13px; }
  .content img { max-width: 100%; height: auto; }
  blockquote { border-left: 3px solid #07c160; margin: 0; padding: 4px 12px; color: #666; background: #f7f7f7; }
  pre { background: #f6f6f6; padding: 12px; overflow-x: auto; border-radius: 6px; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #ddd; padding: 6px 10px; }
</style>
</head>
<body>
<article>
<h1>${title}</h1>
${metaLine}
<hr>
<div class="content">
${bodyHtml}
</div>
</article>
</body>
</html>`;
  }

  /**
   * 提取文章：返回元信息 + 带图片占位符的 Markdown / HTML + 图片 URL 列表（按出现顺序）。
   */
  function extractArticle() {
    const meta = getArticleMeta();
    const contentNode = prepareContentNode();

    // 有效性判断：文字或媒体内容任一存在即为有效文章（纯图片文章无文字）
    if (!contentNode) {
      return { ok: false, error: '当前页面不是有效的微信公众号文章' };
    }
    const hasText = (contentNode.textContent || '').replace(/\u00a0/g, ' ').trim().length > 0;
    const hasMedia = !!contentNode.querySelector('img, video, audio, iframe, mpvideosnap');
    if (!hasText && !hasMedia) {
      return { ok: false, error: '当前页面不是有效的微信公众号文章' };
    }

    // 收集图片并把 src 替换为占位符（Markdown 与 HTML 共用同一套占位符）
    const images = [];
    contentNode.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (!src) return;
      images.push(src);
      img.setAttribute('src', `${IMG_MARK}${images.length - 1}@@`);
    });

    let body = buildTurndown().turndown(contentNode);
    body = body
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const header = [
      `# ${meta.title}`,
      meta.publishTime ? `\n> 发布时间：${meta.publishTime}` : null,
      '',
      '---',
      ''
    ]
      .filter((line) => line !== null)
      .join('\n');

    // HTML 模板：使用占位符已替换的正文 HTML（与 Markdown 共用占位符）
    const html = buildHtmlTemplate(meta, contentNode.innerHTML);

    return {
      ok: true,
      title: meta.title,
      markdown: header + '\n' + body + '\n',
      html,
      images
    };
  }

  /* ---------------- 页面提示 ---------------- */

  function toast(message, isError = false) {
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:48px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:10px 20px', 'border-radius:8px',
      'font-size:14px', 'line-height:1.5', 'color:#fff',
      `background:${isError ? 'rgba(250,80,80,.95)' : 'rgba(7,193,96,.95)'}`,
      'box-shadow:0 4px 16px rgba(0,0,0,.2)', 'pointer-events:none',
      'transition:opacity .4s', 'opacity:0'
    ].join(';');
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 500);
    }, 2500);
  }

  /* ---------------- 消息入口 ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === 'EXTRACT_ARTICLE') {
      try {
        sendResponse(extractArticle());
      } catch (e) {
        console.error('[微信文章转 Markdown]', e);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
      return true;
    }

    if (msg.type === 'SHOW_TOAST') {
      toast(msg.text || '', !!msg.isError);
      sendResponse({ ok: true });
      return true;
    }
  });
})();
