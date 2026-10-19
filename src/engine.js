/*
 * engine.js —— 排版引擎（运行在页面 MAIN world）
 *
 * 为什么必须跑在 MAIN world：
 *   UEditor 的实例挂在页面主世界的 window.UE.instants 上，
 *   默认的隔离世界拿不到它，所以本脚本以 "world": "MAIN" 注入。
 *   MAIN world 里没有 chrome.* API，因此所有 UI 都在 bridge.js（隔离世界），
 *   两边通过 document 上的 CustomEvent 通信，detail 统一用 JSON 字符串。
 *
 * 本文件由原 skills/web-article-typesetting/references/format.js 移植，
 * 去掉了尾部"自动执行 + return"的调试壳，改为事件驱动。
 * 排版前会先清除全部格式（cleanDocument），再套统一排版。
 */
(function () {
  'use strict';

  if (window.__TWS_ENGINE_LOADED__) return;
  window.__TWS_ENGINE_LOADED__ = true;

  /* ------------------------------------------------------------------ *
   * 0. 配置
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    fontSize: '22px',
    lineHeight: '1.5',
    cjkFont: '宋体, SimSun',
    latinFont: "'Times New Roman', serif",
    baseFont: '"Times New Roman", SimSun, serif',
    indent: '2em',
    imgMaxWidth: '100%'
  };

  /* ------------------------------------------------------------------ *
   * 1. 定位 UEditor（顶层 + 同源 iframe，深度 3）
   * ------------------------------------------------------------------ */
  function findUEditor() {
    function probe(win, depth) {
      try {
        if (win.UE && win.UE.instants) {
          var keys = Object.keys(win.UE.instants);
          if (keys.length) {
            return { win: win, name: keys[0], ed: win.UE.instants[keys[0]] };
          }
        }
      } catch (e) { /* 跨域访问忽略 */ }
      if (depth <= 0 || !win.document) return null;
      var frames = win.document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length; i++) {
        try {
          var hit = probe(frames[i].contentWindow, depth - 1);
          if (hit) return hit;
        } catch (e) { /* 跨域 iframe 跳过 */ }
      }
      return null;
    }
    return probe(window, 3);
  }

  function contentLength(ed) {
    try {
      var html = ed && typeof ed.getContent === 'function' ? ed.getContent() : '';
      return html ? html.length : 0;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. 文本分类与工具
   * ------------------------------------------------------------------ */
  var CJK_RE = /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

  function isCJK(ch) { return CJK_RE.test(ch); }

  function normalizeSpace(s) {
    return (s || '').replace(/[\s\u00a0]+/g, ' ').trim();
  }

  /* ------------------------------------------------------------------ *
   * 3. 按中/英把文本节点拆成多个 span（保证编辑器字体下拉框识别为宋体）
   * ------------------------------------------------------------------ */
  function splitTextNode(doc, textNode, opts) {
    var text = textNode.nodeValue;
    if (!text) return;
    var frag = doc.createDocumentFragment();
    var buf = '', cur = null;

    function flush() {
      if (!buf) return;
      var span = doc.createElement('span');
      span.setAttribute('style',
        'font-family: ' + (cur ? opts.cjkFont : opts.latinFont) + ';');
      span.appendChild(doc.createTextNode(buf));
      frag.appendChild(span);
      buf = '';
    }

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === '\n' || ch === '\r' || ch === '\t') { buf += ch; continue; }
      var cjk = isCJK(ch);
      if (cur === null) cur = cjk;
      if (cjk !== cur) { flush(); cur = cjk; }
      buf += ch;
    }
    flush();
    textNode.parentNode.replaceChild(frag, textNode);
  }

  function applyFonts(doc, root, opts) {
    var walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var tag = n.parentNode && n.parentNode.nodeName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      if (!n.nodeValue || !n.nodeValue.replace(/[\s\u00a0]/g, '')) return;
      splitTextNode(doc, n, opts);
    });
  }

  /* ------------------------------------------------------------------ *
   * 4. 清除全部格式（排版前置步骤）
   *    处理 Word/网页粘贴残留：内联样式、class/id、旧字体 span、
   *    加粗斜体下划线等修饰标签、标题层级、o:p、条件注释等。
   *    保留：文字、段落、图片（src/alt）、超链接（href）、br、列表、表格结构。
   * ------------------------------------------------------------------ */
  var KEEP_ATTR = { IMG: ['src', 'alt'], A: ['href', 'target'] };
  var DROP_TAGS = { SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, NOSCRIPT: 1, TEMPLATE: 1, IFRAME: 1, 'O:P': 1 };
  var INLINE_FMT_SEL = 'span,font,b,strong,i,em,u,s,strike,del,ins,mark,small,big,sub,sup,q,cite,abbr,time,label';
  var BLOCKISH_SEL = 'p,div,h1,h2,h3,h4,h5,h6,table,ul,ol,blockquote,figure';

  function toArray(list) { return Array.prototype.slice.call(list); }

  function unwrap(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function convertToP(el, doc) {
    var p = doc.createElement('p');
    while (el.firstChild) p.appendChild(el.firstChild);
    el.parentNode.replaceChild(p, el);
  }

  function cleanDocument(doc, root) {
    // 1) 移除注释与无用标签
    var w = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT, null);
    var junk = [];
    while (w.nextNode()) junk.push(w.currentNode);
    junk.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
    toArray(root.querySelectorAll('*')).forEach(function (el) {
      if (DROP_TAGS[el.nodeName] && el.parentNode) el.parentNode.removeChild(el);
    });

    // 2) 清除所有元素的格式属性（img 保留 src/alt，a 保留 href/target）
    toArray(root.querySelectorAll('*')).forEach(function (el) {
      var keep = KEEP_ATTR[el.nodeName] || [];
      toArray(el.attributes).forEach(function (a) {
        if (keep.indexOf(a.name.toLowerCase()) === -1) el.removeAttribute(a.name);
      });
    });

    // 3) 解包内联格式标签（保留其中文字）
    toArray(root.querySelectorAll(INLINE_FMT_SEL)).forEach(unwrap);

    // 4) 标题/图注/居中标签统一转成 p
    toArray(root.querySelectorAll('h1,h2,h3,h4,h5,h6,figcaption,center')).forEach(function (el) {
      convertToP(el, doc);
    });

    // 5) 容器标签：无块级后代的 div 转为 p，有块级后代的解包；其余容器解包
    toArray(root.querySelectorAll('div')).forEach(function (el) {
      if (el.querySelector(BLOCKISH_SEL)) unwrap(el);
      else convertToP(el, doc);
    });
    toArray(root.querySelectorAll('figure,section,article,header,footer,blockquote,aside,nav,pre')).forEach(unwrap);

    // 6) 解包过程可能再暴露内联残留，兜底再清一次
    toArray(root.querySelectorAll(INLINE_FMT_SEL)).forEach(unwrap);
  }

  /* ------------------------------------------------------------------ *
   * 5. 段落样式
   * ------------------------------------------------------------------ */
  function styleParagraph(p, opts, align) {
    p.style.marginTop = '';
    p.style.marginBottom = '';
    p.style.fontSize = opts.fontSize;
    p.style.lineHeight = opts.lineHeight;
    p.style.fontFamily = opts.baseFont;
    p.style.textAlign = align;
    p.style.textIndent = align === 'center' ? '0' : opts.indent;
  }

  /* ------------------------------------------------------------------ *
   * 6. 主函数：排版（先清除全部格式，再套统一样式）
   * ------------------------------------------------------------------ */
  function formatArticle(html, opts) {
    opts = Object.assign({}, DEFAULTS, opts || {});
    var doc = new DOMParser().parseFromString('<div id="__root__">' + html + '</div>', 'text/html');
    var root = doc.getElementById('__root__');
    cleanDocument(doc, root);          // 步骤一：清除全部格式（Word/网页粘贴残留）
    applyFonts(doc, root, opts);       // 步骤二：按中英拆 span 套字体

    var blocks = root.querySelectorAll('p');
    for (var i = 0; i < blocks.length; i++) {
      var p = blocks[i];
      var imgs = p.querySelectorAll('img');
      var txt = normalizeSpace(p.textContent);
      var isCaption = /^图\s*\d/.test(txt);
      if (imgs.length || isCaption) {
        styleParagraph(p, opts, 'center');          // 图片 / 图标题：居中、不缩进
        for (var j = 0; j < imgs.length; j++) {
          imgs[j].style.maxWidth = opts.imgMaxWidth;
          imgs[j].style.height = 'auto';
        }
      } else if (!txt) {
        styleParagraph(p, opts, 'center');          // 空段落：居中、不缩进
      } else {
        styleParagraph(p, opts, 'justify');         // 正文：两端对齐 + 首行缩进
      }
    }
    return root.innerHTML;
  }

  /* ------------------------------------------------------------------ *
   * 7. 校验：读回编辑器 DOM 输出报告
   * ------------------------------------------------------------------ */
  function verifyArticle(ed) {
    var root = ed.body || (ed.document && ed.document.body);
    if (!root) return { error: 'no editor body' };
    var images = [], captions = [], badParagraphs = [];

    root.querySelectorAll('img').forEach(function (im) {
      var p = im.closest('p');
      images.push({
        src: (im.getAttribute('src') || '').slice(-32),
        paraAlign: p ? getComputedStyle(p).textAlign : '',
        width: Math.round(im.getBoundingClientRect().width)
      });
    });

    root.querySelectorAll('p').forEach(function (p) {
      var t = normalizeSpace(p.textContent);
      if (/^图\s*\d/.test(t)) {
        captions.push({ text: t.slice(0, 60), align: getComputedStyle(p).textAlign });
      } else if (t && getComputedStyle(p).textAlign !== 'justify') {
        badParagraphs.push(t.slice(0, 40));
      }
    });

    return { images: images, captions: captions, nonJustifyParagraphs: badParagraphs };
  }

  /* ------------------------------------------------------------------ *
   * 8. 回写 + 同步（保证后台表单能读到改动）
   * ------------------------------------------------------------------ */
  function writeBack(ed, html) {
    ed.setContent(html);
    try { if (typeof ed.sync === 'function') ed.sync(); } catch (e) {}
    try { if (typeof ed.fireEvent === 'function') ed.fireEvent('contentchange'); } catch (e) {}
  }

  // 每篇文章一份备份，key = 编辑器实例名
  var backups = Object.create(null);

  /* ------------------------------------------------------------------ *
   * 9. 事件桥（与隔离世界通信）
   * ------------------------------------------------------------------ */
  function reply(name, obj) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(obj || {}) }));
    } catch (e) { /* 忽略 */ }
  }

  document.addEventListener('tws:probe', function () {
    var hit = findUEditor();
    reply('tws:probe-result', {
      found: !!hit,
      editorName: hit ? hit.name : null,
      contentLength: hit ? contentLength(hit.ed) : 0
    });
  });

  document.addEventListener('tws:format', function (e) {
    var opts = {};
    try { opts = JSON.parse((e.detail) || '{}'); } catch (err) { opts = {}; }

    var hit = findUEditor();
    if (!hit) {
      reply('tws:format-result', { ok: false, error: '未找到可排版的编辑器实例' });
      return;
    }

    var ed = hit.ed;
    try {
      var before = ed.getContent();
      backups[hit.name] = before;               // 先备份，保证可撤销
      var out = formatArticle(before, opts);
      writeBack(ed, out);
      var report = verifyArticle(ed);
      reply('tws:format-result', {
        ok: true,
        editorName: hit.name,
        report: report,
        backupLength: before ? before.length : 0
      });
    } catch (err) {
      reply('tws:format-result', { ok: false, error: String((err && err.message) || err) });
    }
  });

  document.addEventListener('tws:undo', function () {
    var hit = findUEditor();
    if (!hit) { reply('tws:undo-result', { ok: false, error: '未找到编辑器' }); return; }
    var backup = backups[hit.name];
    if (typeof backup !== 'string') {
      reply('tws:undo-result', { ok: false, error: '没有可撤销的备份' });
      return;
    }
    try {
      writeBack(hit.ed, backup);
      reply('tws:undo-result', { ok: true });
    } catch (err) {
      reply('tws:undo-result', { ok: false, error: String((err && err.message) || err) });
    }
  });

  // 暴露给开发调试
  window.__TWS__ = {
    findUEditor: findUEditor,
    formatArticle: formatArticle,
    verifyArticle: verifyArticle
  };
})();
