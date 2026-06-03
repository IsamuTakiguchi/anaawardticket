// ===========================================================================
// サイドパネル UI コントローラ。
//  - 検索条件フォーム → START_SWEEP
//  - SW との Port (ana-panel) で進捗/結果を受信
//  - 結果テーブルのフィルタ/ソート/CSV、Dev capture タブ
// ===========================================================================

import { buildJobMatrix } from '../core/date-matrix';
import type {
  Cabin,
  RawCapture,
  ResultRow,
  SweepConfig,
  SweepProgress,
  PanelToSwMessage,
  SwToPanelMessage,
  Weekday,
} from '../core/types';
import { DEFAULT_THROTTLE } from '../core/types';
import {
  applyView,
  DEFAULT_VIEW,
  renderTable,
  type OperatorFilter,
  type SortKey,
  type TableViewState,
} from './results-table';
import { downloadText, rowsToCsv } from './csv';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

let rows: ResultRow[] = [];
let view: TableViewState = { ...DEFAULT_VIEW };

// --- Port 接続 -----------------------------------------------------------
const port = chrome.runtime.connect({ name: 'ana-panel' });
port.onMessage.addListener((msg: SwToPanelMessage) => handleSw(msg));
function sendSw(msg: PanelToSwMessage): void {
  port.postMessage(msg);
}

function handleSw(msg: SwToPanelMessage): void {
  switch (msg.type) {
    case 'STATE_SNAPSHOT':
      rows = msg.rows;
      (($('#dev-toggle') as HTMLInputElement).checked = msg.devCapture);
      renderProgress(msg.progress);
      renderResults();
      break;
    case 'PROGRESS':
      renderProgress(msg.progress);
      break;
    case 'RESULT_ROWS':
      rows = msg.rows.length === 0 ? [] : rows.concat(msg.rows);
      renderResults();
      break;
    case 'ERROR':
      alert('エラー: ' + msg.message);
      break;
  }
}

// --- タブ切り替え --------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'dev') refreshCaptureList();
  });
});

// --- フォーム → SweepConfig ---------------------------------------------
function readConfig(): SweepConfig {
  const form = $('#sweep-form') as HTMLFormElement;
  const fd = new FormData(form);
  const weekdays = Array.from(
    form.querySelectorAll<HTMLInputElement>('input[name="wd"]:checked'),
  ).map((el) => Number(el.value) as Weekday);
  return {
    type: fd.get('type') === 'domestic' ? 'domestic' : 'international',
    depart: String(fd.get('depart') ?? '').trim().toUpperCase(),
    dest: String(fd.get('dest') ?? '').trim().toUpperCase(),
    periodStart: String(fd.get('periodStart') ?? ''),
    periodEnd: String(fd.get('periodEnd') ?? ''),
    weekdays,
    returnOffsetDays: Number(fd.get('returnOffsetDays') ?? 0),
    cabin: (fd.get('cabin') as Cabin) ?? 'BUSINESS',
    throttle: {
      ...DEFAULT_THROTTLE,
      baseMs: Number(fd.get('baseMs') ?? DEFAULT_THROTTLE.baseMs),
      spreadMs: Number(fd.get('spreadMs') ?? DEFAULT_THROTTLE.spreadMs),
    },
  };
}

function updateEstimate(): void {
  try {
    const cfg = readConfig();
    if (!cfg.periodStart || !cfg.periodEnd) {
      $('#estimate').textContent = '';
      return;
    }
    const jobs = buildJobMatrix(cfg);
    const t = cfg.throttle ?? DEFAULT_THROTTLE;
    const perJob = t.baseMs + t.spreadMs / 2 + 5000;
    const mins = Math.ceil((jobs.length * perJob) / 60000);
    let note = `検索 ${jobs.length} 件 / 推定 約${mins}分`;
    if (jobs.length > 40) note += ' ⚠ 件数が多いとbot検知リスクが上がります';
    $('#estimate').textContent = note;
  } catch (e) {
    $('#estimate').textContent = (e as Error).message;
  }
}
$('#sweep-form').addEventListener('input', updateEstimate);

// --- 操作ボタン ----------------------------------------------------------
$('#sweep-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = readConfig();
  if (!cfg.depart || !cfg.dest) return alert('出発空港と目的地を入力してください');
  rows = [];
  renderResults();
  sendSw({ type: 'START_SWEEP', config: cfg });
});
$('#btn-pause').addEventListener('click', () => sendSw({ type: 'PAUSE' }));
$('#btn-resume').addEventListener('click', () => sendSw({ type: 'RESUME' }));
$('#btn-cancel').addEventListener('click', () => sendSw({ type: 'CANCEL' }));

// --- 進捗描画 ------------------------------------------------------------
function renderProgress(p: SweepProgress): void {
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const eta = p.etaMs ? ` / 残り約${Math.ceil(p.etaMs / 60000)}分` : '';
  const cur = p.currentJob ? `${p.currentJob.outboundDate}→${p.currentJob.returnDate}` : '—';
  const failBtn =
    p.failed > 0 && (p.state === 'done' || p.state === 'paused' || p.state === 'blocked')
      ? '<button id="btn-retry">失敗分を再実行</button>'
      : '';
  const el = $('#progress');
  el.className = 'progress' + (p.state === 'blocked' ? ' blocked' : '');
  el.innerHTML = `
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="stats">
      <span>状態: <b>${stateLabel(p.state)}</b></span>
      <span>${p.done}/${p.total} (${pct}%)${eta}</span>
      <span>発見:${p.found}</span><span>空き無:${p.empty}</span><span>失敗:${p.failed}</span>
    </div>
    <div>現在: ${cur}</div>
    ${p.message ? `<div class="msg">${p.message}</div>` : ''}
    ${failBtn}
  `;
  const retry = document.getElementById('btn-retry');
  if (retry) retry.addEventListener('click', () => sendSw({ type: 'RETRY_FAILED' }));
  syncButtons(p.state);
}

function stateLabel(s: SweepProgress['state']): string {
  return { idle: '待機', running: '実行中', paused: '一時停止', done: '完了', cancelled: '中止', blocked: '停止(要確認)' }[s];
}

function syncButtons(state: SweepProgress['state']): void {
  const running = state === 'running';
  const resumable = state === 'paused' || state === 'blocked';
  ($('#btn-start') as HTMLButtonElement).disabled = running;
  ($('#btn-pause') as HTMLButtonElement).disabled = !running;
  ($('#btn-resume') as HTMLButtonElement).disabled = !resumable;
  ($('#btn-cancel') as HTMLButtonElement).disabled = !running && !resumable;
}

// --- 結果テーブル --------------------------------------------------------
function renderResults(): void {
  renderTable($('#results'), rows, view);
  $('#results')
    .querySelectorAll<HTMLElement>('th.sortable')
    .forEach((th) =>
      th.addEventListener('click', () => {
        const key = th.dataset.sort as SortKey;
        if (view.sortKey === key) view.sortAsc = !view.sortAsc;
        else { view.sortKey = key; view.sortAsc = true; }
        renderResults();
      }),
    );
}

$('#f-operator').addEventListener('change', (e) => {
  view.operator = (e.target as HTMLSelectElement).value as OperatorFilter;
  renderResults();
});
$('#f-cabin').addEventListener('change', (e) => {
  view.cabin = (e.target as HTMLSelectElement).value as Cabin | 'all';
  renderResults();
});
$('#f-maxmiles').addEventListener('input', (e) => {
  const v = (e.target as HTMLInputElement).value;
  view.maxMiles = v ? Number(v) : null;
  renderResults();
});
$('#f-surcharge-free').addEventListener('change', (e) => {
  view.surchargeFree = (e.target as HTMLInputElement).checked;
  renderResults();
});
$('#btn-csv').addEventListener('click', () => {
  const shown = applyView(rows, view);
  if (shown.length === 0) return alert('出力する結果がありません');
  downloadText(`ana-award-${Date.now()}.csv`, rowsToCsv(shown), 'text/csv');
});
$('#btn-clear').addEventListener('click', () => sendSw({ type: 'CLEAR_RESULTS' }));

// --- Dev capture ---------------------------------------------------------
$('#dev-toggle').addEventListener('change', (e) => {
  sendSw({ type: 'SET_DEV_CAPTURE', enabled: (e.target as HTMLInputElement).checked });
});
$('#btn-dl-captures').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_RAW_CAPTURES' }, (res) => {
    const caps: RawCapture[] = res?.captures ?? [];
    if (caps.length === 0) return alert('キャプチャがありません');
    downloadText(`ana-captures-${Date.now()}.json`, JSON.stringify(caps, null, 2), 'application/json');
  });
});
$('#btn-clear-captures').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_RAW_CAPTURES' }, () => refreshCaptureList());
});
$('#btn-dl-html').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_HTML' }, (res) => {
    if (!res || res.error) return alert('取得失敗: ' + (res?.error ?? '不明') + (res?.url ? `\n現在のタブ: ${res.url}` : ''));
    downloadText(`ana-page-${Date.now()}.html`, res.html, 'text/html');
  });
});
function refreshCaptureList(): void {
  chrome.runtime.sendMessage({ type: 'GET_RAW_CAPTURES' }, (res) => {
    const caps: RawCapture[] = res?.captures ?? [];
    $('#capture-list').innerHTML =
      caps.length === 0
        ? '<p class="note">キャプチャはまだありません。</p>'
        : caps
            .slice(-50)
            .reverse()
            .map(
              (c) =>
                `<div class="cap"><span class="st">${c.status} ${c.method}</span> ${c.url}</div>`,
            )
            .join('');
  });
}

// 初期状態取得
sendSw({ type: 'GET_STATE' });
updateEstimate();
