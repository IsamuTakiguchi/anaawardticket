// ===========================================================================
// MV3 サービスワーカー (エントリ)。
//  - content port (ana-sweep): キャプチャ受信・検索指示送信
//  - panel port (ana-panel): UI からの操作受信・進捗/結果送信
//  - SweepOrchestrator を保持し、storage に永続化して再起動に耐える
// ===========================================================================

import { SweepOrchestrator } from './sweep-orchestrator';
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
const contentPorts = new Set<chrome.runtime.Port>();
const panelPorts = new Set<chrome.runtime.Port>();
let lastProgress: SweepProgress | null = null;

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

// --- スイープ制御 --------------------------------------------------------
async function startSweep(config: SweepConfig): Promise<void> {
  await clearRows();
  orchestrator = new SweepOrchestrator(makeHooks(), config);
  void orchestrator.run();
}

async function restoreOrchestrator(): Promise<void> {
  const saved = await loadSweep();
  if (saved && (saved.state === 'running' || saved.state === 'paused' || saved.state === 'blocked')) {
    orchestrator = new SweepOrchestrator(makeHooks(), saved.config, saved.jobs);
    // 復元直後は実行しない (ユーザーの Resume を待つ)。running は paused 扱いに。
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
  const progress: SweepProgress =
    lastProgress ??
    ({
      state: (orchestrator?.getState() ?? 'idle') as SweepRunState,
      total: orchestrator?.getJobs().length ?? 0,
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
      break;
    case 'RESUME':
      if (orchestrator) void orchestrator.run();
      break;
    case 'CANCEL':
      orchestrator?.cancel();
      break;
    case 'RETRY_FAILED':
      if (orchestrator) {
        orchestrator.resetFailed();
        void orchestrator.run();
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
  return false;
});
