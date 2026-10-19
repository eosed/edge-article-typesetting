/*
 * bridge.js —— 悬浮按钮 UI + 事件桥（运行在隔离世界 ISOLATED world）
 *
 * 职责：
 *   1. 探测页面里是否存在编辑器（通过 tws:probe 事件问主世界）；
 *   2. 存在时，在右下角显示悬浮按钮；
 *   3. 点击后驱动主世界排版（tws:format），展示结果，并提供「撤销」（tws:undo）；
 *   4. 接收来自 background.js 的工具栏图标触发消息。
 *
 * 隔离世界有 chrome.* API，但没有 window.UE，
 * 因此所有对编辑器的操作都通过 CustomEvent 转发给 engine.js。
 */
(function () {
  'use strict';

  if (window.__TWS_BRIDGE_LOADED__) return;
  window.__TWS_BRIDGE_LOADED__ = true;

  var PROBE_INTERVAL = 1500;   // 探测间隔
  var PROBE_MAX = 20;          // 最多探测次数（约 30 秒）
  var probeTimer = null;
  var probeCount = 0;
  var editorFound = false;
  var busy = false;
  var ui = null;

  /* ------------------------------------------------------------------ *
   * 1. 与主世界通信
   * ------------------------------------------------------------------ */
  function toEngine(name, payload) {
    document.dispatchEvent(new CustomEvent(name, {
      detail: JSON.stringify(payload || {})
    }));
  }

  function once(name, handler, timeout) {
    var done = false;
    function onEvent(e) {
      if (done) return;
      done = true;
      document.removeEventListener(name, onEvent);
      var data = {};
      try { data = JSON.parse(e.detail || '{}'); } catch (err) { data = {}; }
      handler(data);
    }
    document.addEventListener(name, onEvent);
    if (timeout) {
      setTimeout(function () {
        if (done) return;
        done = true;
        document.removeEventListener(name, onEvent);
        handler(null);
      }, timeout);
    }
  }

  /* ------------------------------------------------------------------ *
   * 2. UI（Shadow DOM，避免污染页面样式）
   * ------------------------------------------------------------------ */
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.launcher{position:fixed;right:24px;bottom:24px;z-index:2147483647;width:52px;height:52px;border:none;border-radius:26px;',
    'background:#1a73e8;color:#fff;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 16px rgba(0,0,0,.24);',
    'transition:transform .15s ease,box-shadow .15s ease;line-height:1.1}',
    '.launcher:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.3)}',
    '.launcher:active{transform:translateY(0)}',
    '.launcher.busy{background:#8ab4f8;cursor:progress}',
    '.panel{position:fixed;right:24px;bottom:88px;z-index:2147483647;width:250px;background:#fff;border-radius:12px;',
    'box-shadow:0 10px 32px rgba(0,0,0,.22);padding:14px;display:none;color:#202124}',
    '.panel.open{display:block}',
    '.title{font-size:13px;font-weight:600;margin-bottom:2px}',
    '.sub{font-size:11px;color:#5f6368;margin-bottom:12px}',
    '.btn{display:block;width:100%;padding:9px 12px;border-radius:8px;border:1px solid #dadce0;background:#fff;',
    'font-size:13px;cursor:pointer;margin-bottom:8px;text-align:center;color:#202124;transition:background .12s}',
    '.btn:hover{background:#f1f3f4}',
    '.btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}',
    '.btn.primary:hover{background:#1765cc}',
    '.btn:disabled{opacity:.45;cursor:not-allowed;background:#f1f3f4}',
    '.status{font-size:11px;color:#5f6368;line-height:1.5;margin-top:4px;white-space:pre-wrap}',
    '.toast{position:fixed;right:24px;bottom:88px;z-index:2147483647;max-width:280px;background:#202124;color:#fff;',
    'border-radius:10px;padding:11px 14px;font-size:12px;line-height:1.6;box-shadow:0 8px 24px rgba(0,0,0,.3);',
    'opacity:0;transform:translateY(8px);transition:opacity .2s,transform .2s;pointer-events:none}',
    '.toast.show{opacity:1;transform:translateY(0);pointer-events:auto}',
    '.toast .link{color:#8ab4f8;cursor:pointer;text-decoration:underline;margin-left:6px}'
  ].join('');

  function buildUI() {
    if (ui) return ui;
    var host = document.createElement('div');
    host.id = '__tws_host__';
    host.style.cssText = 'all:initial;position:static;';
    var shadow = host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS;

    var launcher = document.createElement('button');
    launcher.className = 'launcher';
    launcher.title = '网页文章规范化排版';
    launcher.textContent = '排版';

    var panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML =
      '<div class="title">网页文章规范化排版</div>' +
      '<div class="sub">22px · 1.5 倍行距 · 中文宋体 · 英文 Times New Roman</div>';
    var btnFormat = document.createElement('button');
    btnFormat.className = 'btn primary';
    btnFormat.textContent = '一键排版';
    var btnUndo = document.createElement('button');
    btnUndo.className = 'btn';
    btnUndo.textContent = '撤销上一步';
    var status = document.createElement('div');
    status.className = 'status';
    panel.appendChild(btnFormat);
    panel.appendChild(btnUndo);
    panel.appendChild(status);

    var toast = document.createElement('div');
    toast.className = 'toast';

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(launcher);
    shadow.appendChild(toast);
    (document.body || document.documentElement).appendChild(host);

    launcher.addEventListener('click', function () {
      panel.classList.toggle('open');
    });
    btnFormat.addEventListener('click', function () { runFormat(); });
    btnUndo.addEventListener('click', function () { runUndo(); });

    ui = { host: host, launcher: launcher, panel: panel, btnFormat: btnFormat, btnUndo: btnUndo, status: status, toast: toast };
    return ui;
  }

  function showToast(text, undoLabel) {
    var u = buildUI();
    u.toast.innerHTML = '';
    u.toast.appendChild(document.createTextNode(text));
    if (undoLabel) {
      var link = document.createElement('span');
      link.className = 'link';
      link.textContent = undoLabel;
      link.addEventListener('click', function () {
        hideToast();
        runUndo();
      });
      u.toast.appendChild(link);
    }
    u.toast.classList.add('show');
    clearTimeout(u.toast.__timer);
    u.toast.__timer = setTimeout(hideToast, undoLabel ? 6000 : 3500);
  }

  function hideToast() {
    if (ui) ui.toast.classList.remove('show');
  }

  function setStatus(text) {
    var u = buildUI();
    u.status.textContent = text || '';
  }

  function setBusy(v) {
    busy = v;
    var u = buildUI();
    u.launcher.classList.toggle('busy', v);
    u.btnFormat.disabled = v;
  }

  /* ------------------------------------------------------------------ *
   * 3. 业务流程
   * ------------------------------------------------------------------ */
  function runFormat() {
    if (busy) return;
    setBusy(true);
    setStatus('正在排版…');
    once('tws:format-result', function (res) {
      setBusy(false);
      if (!res) {
        setStatus('排版超时，请重试。');
        showToast('排版超时，未收到编辑器响应。');
        return;
      }
      if (!res.ok) {
        setStatus('排版失败：' + (res.error || '未知错误'));
        showToast('排版失败：' + (res.error || '未知错误'));
        return;
      }
      var r = res.report || {};
      var imgs = (r.images || []).length;
      var caps = (r.captions || []).length;
      var bad = (r.nonJustifyParagraphs || []).length;
      var msg = '排版完成 · 图片 ' + imgs + ' 张 · 图标题 ' + caps + ' 处';
      if (bad > 0) msg += ' · 仍有 ' + bad + ' 段未两端对齐';
      setStatus(msg + '\n记得回到编辑器的保存按钮提交。');
      showToast(msg, '撤销');
    }, 15000);
    toEngine('tws:format', {});
  }

  function runUndo() {
    if (busy) return;
    setBusy(true);
    setStatus('正在撤销…');
    once('tws:undo-result', function (res) {
      setBusy(false);
      if (res && res.ok) {
        setStatus('已撤销到排版前的内容。');
        showToast('已撤销到排版前的内容。');
      } else {
        var err = (res && res.error) || '撤销失败';
        setStatus(err);
        showToast(err);
      }
    }, 8000);
    toEngine('tws:undo', {});
  }

  /* ------------------------------------------------------------------ *
   * 4. 探测编辑器，必要时显示悬浮按钮
   * ------------------------------------------------------------------ */
  function probeOnce() {
    once('tws:probe-result', function (res) {
      if (res && res.found) {
        editorFound = true;
        stopProbe();
        buildUI();                      // 出现悬浮按钮
        setStatus('已检测到编辑器，点「一键排版」开始。');
      } else {
        probeCount++;
        if (probeCount >= PROBE_MAX) stopProbe();
      }
    }, 1200);
    toEngine('tws:probe', {});
  }

  function startProbe() {
    if (editorFound) return;
    probeOnce();
    probeTimer = setInterval(function () {
      if (editorFound || probeCount >= PROBE_MAX) { stopProbe(); return; }
      probeOnce();
    }, PROBE_INTERVAL);
  }

  function stopProbe() {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  }

  /* ------------------------------------------------------------------ *
   * 5. 接收工具栏图标点击
   * ------------------------------------------------------------------ */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.type !== 'TWS_TRIGGER') return;
      if (!editorFound) {
        // 可能编辑器刚加载，重新探测一次
        once('tws:probe-result', function (res) {
          if (res && res.found) {
            editorFound = true;
            buildUI();
            runFormat();
          } else {
            showToast('当前页面未检测到可排版的编辑器。');
          }
        }, 1200);
        toEngine('tws:probe', {});
      } else {
        buildUI();
        runFormat();
      }
      sendResponse && sendResponse({ ok: true });
      return true;
    });
  } catch (e) { /* 扩展上下文失效时忽略 */ }

  /* ------------------------------------------------------------------ *
   * 6. 启动
   * ------------------------------------------------------------------ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startProbe);
  } else {
    startProbe();
  }
  // 页面从隐藏切回可见时，若还没找到，再试一次
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !editorFound && probeCount < PROBE_MAX) startProbe();
  });
})();
