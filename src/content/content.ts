// ===========================================================================
// ISOLATED ワールド content script。
//  - MAIN ワールドの interceptor からの window.postMessage を受信
//  - service worker と長命 Port で接続し、キャプチャを中継
//  - SW からの検索指示 (RUN_SEARCH) を page-driver に渡す
//  - challenge (再ログイン/captcha) の兆候を検知して SW に通知
// ===========================================================================

import type {
  ContentToSwMessage,
  PageCaptureMessage,
  SwToContentMessage,
} from '../core/types';
import { runSearch } from './page-driver';

const PORT_NAME = 'ana-sweep';
let port: chrome.runtime.Port | null = null;

function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: PORT_NAME });
  p.onMessage.addListener((msg: SwToContentMessage) => handleSwMessage(msg));
  p.onDisconnect.addListener(() => {
    port = null;
    // SW が一時停止していても、次回キャプチャ時に再接続する
  });
  port = p;
  send({ type: 'PAGE_READY', url: location.href });
  return p;
}

function send(msg: ContentToSwMessage): void {
  try {
    (port ?? connect()).postMessage(msg);
  } catch {
    port = connect();
    port.postMessage(msg);
  }
}

// --- MAIN ワールドからのキャプチャ受信 ----------------------------------
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as PageCaptureMessage | undefined;
  if (!data || data.__ana_ext !== true || data.kind !== 'capture') return;

  const cap = data.capture;
  // challenge 兆候: 認証要求やエラーステータス、JSON でない HTML レスポンス
  if (cap.status === 401 || cap.status === 403 || cap.status === 429) {
    send({ type: 'CHALLENGE_DETECTED', reason: `HTTP ${cap.status}` });
  } else if (/<html|login|ログイン|captcha/i.test(cap.body.slice(0, 500)) && cap.body.trimStart().startsWith('<')) {
    send({ type: 'CHALLENGE_DETECTED', reason: 'HTML/ログイン応答を検出' });
  }
  send({ type: 'CAPTURE', capture: cap });
});

// --- SW からの指示 ------------------------------------------------------
function setDevCapture(enabled: boolean): void {
  window.dispatchEvent(new CustomEvent('__ana_ext_dev_capture', { detail: enabled }));
}

async function handleSwMessage(msg: SwToContentMessage): Promise<void> {
  switch (msg.type) {
    case 'RUN_SEARCH':
      await runSearch(msg.job, msg.config);
      break;
    case 'SET_DEV_CAPTURE':
      setDevCapture(msg.enabled);
      break;
  }
}

// dev capture 状態を SW から取得して同期
chrome.storage.local.get('devCapture').then((v) => setDevCapture(Boolean(v.devCapture)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.devCapture) setDevCapture(Boolean(changes.devCapture.newValue));
});

connect();
