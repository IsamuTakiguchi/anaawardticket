// ===========================================================================
// MV3 サービスワーカー (エントリ)。
//  - content port (ana-sweep): キャプチャ受信・検索指示送信
//  - panel port (ana-panel): UI からの操作受信・進捗/結果送信
//  - SweepOrchestrator を保持し、storage に永続化して再起動に耐える
// ===========================================================================

import { SweepOrchestrator } from './sweep-orchestrator';
import { LegacySweepController, type LegacyHooks } from './legacy-sweep';
import {
  appendRows,
  clearRawCaptures,
  clearRows,
  getDevCapture,
  loadRawCaptures,
  loadRows,
  loadSweep,
  recordRawCapture,
  saveSweep,
  setDevCapture,
} from './capture-store';
import { isAvailabilityCall } from '../core/endpoints';
import type {
  ContentToSwMessage,
  PanelToSwMessage,
  ResultRow,
  SearchJob,
  SweepConfig,
  SweepProgress,
  SweepRunState,
  SwToContentMessage,
  SwToPanelMessage,
} from '../core/types';

let orchestrator: SweepOrchestrator | null = null;
let legacy: LegacySweepController | null = null;
let legacyTimer: ReturnType<typeof setTimeout> | null = null;
const contentPorts = new Set<chrome.runtime.Port>();
const panelPorts = new Set<chrome.runtime.Port>();
let lastProgress: SweepProgress | null = null;

/** 旧国際線エンジン方式を使うか (engine 明示 or 国際線は旧エンジンが本流) */
function usesLegacy(config: SweepConfig): boolean {
  return config.engine === 'legacy-intl' || (config.engine == null && config.type === 'international');
}

// --- アクションクリックでサイドパネルを開く ------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);
});

// --- ユーティリティ ------------------------------------------------------
function broadcastToPanels(msg: SwToPanelMessage): void {
  for (const p of panelPorts) {
    try {
      p.postMessage(msg);
    } catch {
      panelPorts.delete(p);
    }
  }
}

function sendToContent(msg: SwToContentMessage): void {
  for (const p of contentPorts) {
    try {
      p.postMessage(msg);
    } catch {
      contentPorts.delete(p);
    }
  }
}

/**
 * ANAのタブへ直接 one-shot メッセージを送る。Port が切れていても届くため、
 * 旧国際線スイープの再検索指示はこちらを使う。
 */
function sendToAnaTabs(msg: SwToContentMessage): void {
  chrome.tabs.query(
    { url: ['https://aswbe-i.ana.co.jp/*', 'https://aswbe.ana.co.jp/*'] },
    (tabs) => {
      console.info('[ana-sweep:sw] ANAタブ数=', tabs.length, '→', msg.type);
      for (const t of tabs) {
        if (t.id != null) {
          chrome.tabs.sendMessage(t.id, msg, () => void chrome.runtime.lastError);
        }
      }
    },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeHooks() {
  return {
    runSearch: (job: SearchJob, config: SweepConfig) =>
      sendToContent({ type: 'RUN_SEARCH', job, config }),
    onRows: (rows: ResultRow[]) => {
      void appendRows(rows);
      broadcastToPanels({ type: 'RESULT_ROWS', rows });
    },
    onProgress: (progress: SweepProgress) => {
      lastProgress = progress;
      broadcastToPanels({ type: 'PROGRESS', progress });
    },
    persist: (jobs: SearchJob[], state: SweepRunState, cursor: number, config: SweepConfig) =>
      void saveSweep({ config, jobs, state, cursor }),
    sleep,
  };
}

function makeLegacyHooks(): LegacyHooks {
  return {
    submit: (outboundDate, returnDate) => {
      const msg = { type: 'LEGACY_SUBMIT', outboundDate, returnDate } as const;
      sendToAnaTabs(msg); // Port が切れていても届く確実な経路
      sendToContent(msg); // 接続中の Port にも (冗長)
    },
    onRows: (rows: ResultRow[]) => {
      void appendRows(rows);
      broadcastToPanels({ type: 'RESULT_ROWS', rows });
    },
    onProgress: (progress: SweepProgress) => {
      lastProgress = progress;
      broadcastToPanels({ type: 'PROGRESS', progress });
    },
    persist: (jobs: SearchJob[], state: SweepRunState, cursor: number, config: SweepConfig) =>
      void saveSweep({ config, jobs, state, cursor }),
    setTimer: (ms, fn) => {
      if (legacyTimer) clearTimeout(legacyTimer);
      legacyTimer = setTimeout(fn, ms);
    },
    clearTimer: () => {
      if (legacyTimer) clearTimeout(legacyTimer);
      legacyTimer = null;
    },
  };
}

// --- スイープ制御 --------------------------------------------------------
async function startSweep(config: SweepConfig): Promise<void> {
  console.info('[ana-sweep:sw] START_SWEEP', config.type, config.depart, '→', config.dest);
  // 既存スイープを確実に停止してから新規開始 (タイマー・コントローラを破棄)
  if (legacyTimer) { clearTimeout(legacyTimer); legacyTimer = null; }
  orchestrator?.cancel();
  legacy?.cancel();
  orchestrator = null;
  legacy = null;
  await clearRows();
  if (usesLegacy(config)) {
    orchestrator = null;
    legacy = new LegacySweepController(makeLegacyHooks(), config);
    legacy.start();
  } else {
    legacy = null;
    orchestrator = new SweepOrchestrator(makeHooks(), config);
    void orchestrator.run();
  }
}

async function restoreOrchestrator(): Promise<void> {
  const saved = await loadSweep();
  if (saved && (saved.state === 'running' || saved.state === 'paused' || saved.state === 'blocked')) {
    if (usesLegacy(saved.config)) {
      legacy = new LegacySweepController(makeLegacyHooks(), saved.config, saved.jobs, saved.cursor);
      // 復元直後は実行しない。次の結果ページ読込 or ユーザーの Resume を待つ。
    } else {
      orchestrator = new SweepOrchestrator(makeHooks(), saved.config, saved.jobs);
    }
  }
}
void restoreOrchestrator();

// --- content port --------------------------------------------------------
function handleContentMessage(msg: ContentToSwMessage): void {
  switch (msg.type) {
    case 'CAPTURE': {
      void getDevCapture().then((dev) => {
        if (dev) void recordRawCapture(msg.capture);
      });
      if (isAvailabilityCall(msg.capture.url)) {
        orchestrator?.acceptCapture(msg.capture);
      }
      break;
    }
    case 'CHALLENGE_DETECTED':
      orchestrator?.block(msg.reason);
      legacy?.block(msg.reason);
      break;
    case 'LEGACY_PAGE_READY':
      legacy?.onPageReady(msg.outboundDate, msg.returnDate, msg.rows, msg.isResultPage);
      break;
    case 'PAGE_READY':
      // dev capture 状態を新しいページへ伝える
      void getDevCapture().then((dev) =>
        sendToContent({ type: 'SET_DEV_CAPTURE', enabled: dev }),
      );
      break;
  }
}

// --- panel port ----------------------------------------------------------
async function snapshot(port: chrome.runtime.Port): Promise<void> {
  const rows = await loadRows();
  const dev = await getDevCapture();
  const active = orchestrator ?? legacy;
  const progress: SweepProgress =
    lastProgress ??
    ({
      state: (active?.getState() ?? 'idle') as SweepRunState,
      total: active?.getJobs().length ?? 0,
      done: 0,
      found: 0,
      empty: 0,
      failed: 0,
    } satisfies SweepProgress);
  try {
    port.postMessage({ type: 'STATE_SNAPSHOT', progress, rows, devCapture: dev } satisfies SwToPanelMessage);
  } catch {
    /* noop */
  }
}

async function handlePanelMessage(msg: PanelToSwMessage, port: chrome.runtime.Port): Promise<void> {
  switch (msg.type) {
    case 'START_SWEEP':
      await startSweep(msg.config);
      break;
    case 'PAUSE':
      orchestrator?.pause();
      legacy?.pause();
      break;
    case 'RESUME':
      if (orchestrator) void orchestrator.run();
      legacy?.resume();
      break;
    case 'CANCEL':
      orchestrator?.cancel();
      legacy?.cancel();
      break;
    case 'RETRY_FAILED':
      if (orchestrator) {
        orchestrator.resetFailed();
        void orchestrator.run();
      }
      if (legacy) {
        legacy.resetFailed();
        legacy.resume();
      }
      break;
    case 'CLEAR_RESULTS':
      await clearRows();
      broadcastToPanels({ type: 'RESULT_ROWS', rows: [] });
      break;
    case 'SET_DEV_CAPTURE':
      await setDevCapture(msg.enabled);
      sendToContent({ type: 'SET_DEV_CAPTURE', enabled: msg.enabled });
      break;
    case 'GET_STATE':
      await snapshot(port);
      break;
  }
}

// --- Port 接続ハンドラ ---------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ana-sweep') {
    contentPorts.add(port);
    port.onMessage.addListener((m: ContentToSwMessage) => handleContentMessage(m));
    port.onDisconnect.addListener(() => contentPorts.delete(port));
  } else if (port.name === 'ana-panel') {
    panelPorts.add(port);
    port.onMessage.addListener((m: PanelToSwMessage) => void handlePanelMessage(m, port));
    port.onDisconnect.addListener(() => panelPorts.delete(port));
    void snapshot(port);
  }
});

// --- dev capture ダウンロード用 (panel から runtime message で要求) -----
chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req?.type === 'GET_RAW_CAPTURES') {
    void loadRawCaptures().then((c) => sendResponse({ captures: c }));
    return true; // async
  }
  if (req?.type === 'CLEAR_RAW_CAPTURES') {
    void clearRawCaptures().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (req?.type === 'GET_PAGE_HTML') {
    // アクティブな ANA タブの DOM (サーバーレンダリングされた結果ページ) を取得。
    // 旧エンジンは結果を HTML に埋め込むため、DOM 解析の元データとして使う。
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return sendResponse({ error: 'アクティブなタブが見つかりません' });
        if (!/(^https:\/\/aswbe)/.test(tab.url ?? '')) {
          return sendResponse({ error: 'ANA予約サイト(aswbe)のタブをアクティブにしてください', url: tab.url });
        }
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({ url: location.href, html: document.documentElement.outerHTML }),
        });
        sendResponse(res?.result ?? { error: '取得に失敗しました' });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }
  return false;
});
