/*
 * background.js —— service worker
 *
 * 职责：点击工具栏图标时，通知当前页面的 bridge.js 执行一次排版。
 * 若页面尚未注入内容脚本（例如扩展刚重载、旧标签页），则兜底手动注入。
 */
'use strict';

var RESTRICTED = /^(chrome|edge|about|devtools|chrome-extension|edge-extension|view-source):/i;

function isInjectable(url) {
  return !!url && !RESTRICTED.test(url);
}

async function ensureScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['src/engine.js'],
      world: 'MAIN'
    });
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['src/bridge.js'],
      world: 'ISOLATED'
    });
    return true;
  } catch (e) {
    return false;
  }
}

chrome.action.onClicked.addListener(async function (tab) {
  if (!tab || !tab.id) return;

  if (!isInjectable(tab.url)) {
    await flashBadge(tab.id, '×');
    return;
  }

  // 先尝试直接通知（静态注入的情况下内容脚本通常已在）
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TWS_TRIGGER' });
    return;
  } catch (e) {
    // 内容脚本不在，兜底注入后再通知
  }

  var ok = await ensureScripts(tab.id);
  if (!ok) {
    await flashBadge(tab.id, '×');
    return;
  }
  // 等脚本注册好监听
  await new Promise(function (r) { setTimeout(r, 300); });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TWS_TRIGGER' });
  } catch (e) {
    await flashBadge(tab.id, '×');
  }
});

async function flashBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId: tabId, text: text });
    await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#d93025' });
    setTimeout(function () {
      chrome.action.setBadgeText({ tabId: tabId, text: '' }).catch(function () {});
    }, 2000);
  } catch (e) { /* 忽略 */ }
}
