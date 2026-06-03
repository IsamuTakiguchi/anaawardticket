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
import { extractAnaAirports, isLegacyAwardPage, isNoResultsPage, legacySubmit, parseCurrentPage } from './legacy-driver';

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
    case 'LEGACY_SUBMIT': {
      console.info('[ana-sweep] LEGACY_SUBMIT 受信', msg.outboundDate, msg.returnDate);
      const ok = legacySubmit(msg.outboundDate, msg.returnDate, msg.depart, msg.dest, msg.cabin);
      if (!ok) {
        // フォーム投入に失敗 → 当該ジョブのみ失敗扱い (全体は止めない)。
        // CHALLENGE_DETECTED は認証要求専用とし、ここでは使わない。
        send({ type: 'LEGACY_SUBMIT_FAILED', reason: '再検索フォームを操作できませんでした' });
      }
      break;
    }
  }
}

// --- 旧国際線エンジン: 結果ページ読込を SW に報告 -------------------------
// ページ遷移のたびに content script は再実行される。結果ページなら解析して
// 現在の日付ペアと行を SW に送る (スイープ制御が次の検索を投入する)。
function reportLegacyPageIfResult(): void {
  const onAward = isLegacyAwardPage();
  console.info('[ana-sweep] content script 稼働中:', location.href, '/ award系ページ=', onAward);
  if (!onAward) return;
  // ANAの空港リストを取り込んで保存 (パネルのドロップダウンに利用)
  try {
    const list = extractAnaAirports();
    if (list) {
      void chrome.storage.local.set({ anaAirports: list });
      console.info('[ana-sweep] 空港リスト取り込み', list.airports.length, '件');
    }
  } catch { /* noop */ }
  const noResults = isNoResultsPage();
  // 空席あり(便一覧)も空席なしページも、検索条件が読めれば報告する。
  // 空席なしページは便が無いため rows=[] となり、上位は「空席なし」として次へ進む。
  const parsed = parseCurrentPage();
  if (parsed) {
    console.info(`[ana-sweep] ページ報告 ${parsed.dest} ${parsed.cabin} ${parsed.outboundDate}→${parsed.returnDate} 行数=${parsed.rows.length}${noResults ? ' (空席なし)' : ''}`);
    send({
      type: 'LEGACY_PAGE_READY',
      outboundDate: parsed.outboundDate,
      returnDate: parsed.returnDate,
      dest: parsed.dest,
      cabin: parsed.cabin,
      rows: parsed.rows,
      isResultPage: !noResults,
      noResults,
    });
    return;
  }
  // 検索条件が読めない＝空席なしで条件設定ページに飛ばされた可能性が高い。
  // 日付が読めなくても、実行中ジョブを「空席なし」として次へ進めるため報告する。
  if (noResults) {
    console.info('[ana-sweep] 条件設定ページ(空席なし)を検出。実行中ジョブを空席なしとして次へ進めます');
    send({
      type: 'LEGACY_PAGE_READY',
      outboundDate: '',
      returnDate: '',
      dest: '',
      cabin: 'ECONOMY',
      rows: [],
      isResultPage: false,
      noResults: true,
    });
    return;
  }
  // 診断用: フォームのフィールドID・検索ボタンを出力 (入力ページの構造特定のため)
  dumpFormDiagnostics();
  console.warn('[ana-sweep] award系ページだが検索条件を読めず、空席なし表示も無いため報告を見送りました');
}

/** 入力/条件ページのフォーム構造を特定するための診断ログ。
 *  日付・空港・クラスらしき入力欄IDと、検索ボタン候補を列挙する。 */
function dumpFormDiagnostics(): void {
  try {
    const TAG = '[ana-sweep:diag]';
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'));
    const interesting = inputs
      .filter((el) => /date|depart|arriv|airport|board|class|cff/i.test(el.id + ' ' + el.getAttribute('name')))
      .map((el) => `${el.tagName}#${el.id || '(no-id)'}[name=${el.getAttribute('name') ?? ''}]=${(el as HTMLInputElement).value ?? ''}`);
    console.info(`${TAG} 候補入力欄:`, interesting.length ? interesting : '(該当なし)');
    const buttons = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input[type="submit"],input[type="button"],button,a[role="button"]'),
    )
      .map((b) => ('value' in b && b.value ? b.value : b.textContent?.trim()) || '')
      .filter((t) => /検索|search/i.test(t));
    console.info(`${TAG} 検索ボタン候補:`, buttons.length ? buttons : '(該当なし)');
  } catch { /* noop */ }
}
if (document.readyState === 'complete') reportLegacyPageIfResult();
else window.addEventListener('load', reportLegacyPageIfResult);

// dev capture 状態を SW から取得して同期
chrome.storage.local.get('devCapture').then((v) => setDevCapture(Boolean(v.devCapture)));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.devCapture) setDevCapture(Boolean(changes.devCapture.newValue));
});

// Port に加えて one-shot メッセージ (chrome.tabs.sendMessage) も受け付ける。
// サービスワーカー再起動で Port が切れていても指示が届くようにするため。
chrome.runtime.onMessage.addListener((msg: SwToContentMessage, _sender, sendResponse) => {
  if (msg && (msg.type === 'LEGACY_SUBMIT' || msg.type === 'RUN_SEARCH' || msg.type === 'SET_DEV_CAPTURE')) {
    void handleSwMessage(msg);
    try { sendResponse({ ok: true }); } catch { /* noop */ }
  }
  return false;
});

connect();
