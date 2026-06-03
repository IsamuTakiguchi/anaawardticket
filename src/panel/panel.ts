// ===========================================================================
// サイドパネル UI コントローラ。
//  - 検索条件フォーム → START_SWEEP
//  - SW との Port (ana-panel) で進捗/結果を受信
//  - 結果テーブルのフィルタ/ソート/CSV、Dev capture タブ
// ===========================================================================

import { buildJobMatrix } from '../core/date-matrix';
import type {
  AnaAirportList,
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
import { parseLegacyIntlResult } from '../core/legacy-intl-parser';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

let rows: ResultRow[] = [];
let view: TableViewState = { ...DEFAULT_VIEW };

// --- 空港リスト & 目的地(複数) -------------------------------------------
// ANAページ未取得時の代表的フォールバック (code・名前・地域)
const FALLBACK: AnaAirportList = {
  regions: [
    { code: 'JP', name: '日本' }, { code: 'AS', name: 'アジア' },
    { code: 'OC', name: 'ハワイ・オセアニア' }, { code: 'NA', name: '北米' }, { code: 'EU', name: 'ヨーロッパ' },
  ],
  airports: [
    { code: 'HND', name: '東京(羽田)', region: 'JP' }, { code: 'NRT', name: '東京(成田)', region: 'JP' },
    { code: 'KIX', name: '大阪(関西)', region: 'JP' }, { code: 'ITM', name: '大阪(伊丹)', region: 'JP' },
    { code: 'NGO', name: '名古屋(中部)', region: 'JP' }, { code: 'FUK', name: '福岡', region: 'JP' },
    { code: 'CTS', name: '札幌(新千歳)', region: 'JP' }, { code: 'OKA', name: '沖縄(那覇)', region: 'JP' },
    { code: 'ICN', name: 'ソウル(仁川)', region: 'AS' }, { code: 'TPE', name: '台北(桃園)', region: 'AS' },
    { code: 'HKG', name: '香港', region: 'AS' }, { code: 'BKK', name: 'バンコク', region: 'AS' },
    { code: 'SIN', name: 'シンガポール', region: 'AS' }, { code: 'MNL', name: 'マニラ', region: 'AS' },
    { code: 'HNL', name: 'ホノルル', region: 'OC' }, { code: 'GUM', name: 'グアム', region: 'OC' },
    { code: 'SYD', name: 'シドニー', region: 'OC' },
    { code: 'LAX', name: 'ロサンゼルス', region: 'NA' }, { code: 'SFO', name: 'サンフランシスコ', region: 'NA' },
    { code: 'JFK', name: 'ニューヨーク', region: 'NA' }, { code: 'YVR', name: 'バンクーバー', region: 'NA' },
    { code: 'LHR', name: 'ロンドン', region: 'EU' }, { code: 'FRA', name: 'フランクフルト', region: 'EU' },
    { code: 'CDG', name: 'パリ', region: 'EU' }, { code: 'MUC', name: 'ミュンヘン', region: 'EU' },
  ],
};
let airportList: AnaAirportList = FALLBACK;
const airportName = (code: string): string =>
  airportList.airports.find((a) => a.code === code)?.name ?? code;
let selectedDests: string[] = [];

/** 上部にまとめて表示する主要空港 (この順で並べる) */
const MAJOR_CODES = [
  'HND', 'NRT', 'KIX', 'ITM', 'NGO', 'FUK', 'CTS', 'OKA',
  'ICN', 'GMP', 'TPE', 'TSA', 'HKG', 'PVG', 'PEK', 'BKK', 'SIN', 'KUL', 'MNL', 'HAN', 'SGN', 'DPS',
  'HNL', 'GUM', 'SPN', 'SYD', 'MEL',
  'LAX', 'SFO', 'SJC', 'SEA', 'JFK', 'ORD', 'IAD', 'IAH', 'YVR', 'YYZ',
  'LHR', 'CDG', 'FRA', 'MUC', 'BRU', 'VIE', 'IST', 'HEL',
];

function optionFor(a: { code: string; name: string }): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = a.code;
  o.textContent = `${a.name} ${a.code}`;
  return o;
}

function fillSelect(sel: HTMLSelectElement, list: AnaAirportList, defaultCode: string): void {
  const byCode = new Map(list.airports.map((a) => [a.code, a]));
  const regionName = new Map(list.regions.map((r) => [r.code, r.name]));
  const byRegion = new Map<string, typeof list.airports>();
  for (const a of list.airports) {
    const g = byRegion.get(a.region) ?? [];
    g.push(a);
    byRegion.set(a.region, g);
  }
  sel.innerHTML = '';
  // 主要都市を先頭グループに
  const majors = MAJOR_CODES.map((c) => byCode.get(c)).filter((a): a is (typeof list.airports)[number] => !!a);
  if (majors.length) {
    const og = document.createElement('optgroup');
    og.label = '★ 主要都市';
    for (const a of majors) og.appendChild(optionFor(a));
    sel.appendChild(og);
  }
  // 続いて地域別の全空港
  for (const [rc, aps] of byRegion) {
    const og = document.createElement('optgroup');
    og.label = regionName.get(rc) ?? rc;
    for (const a of aps) og.appendChild(optionFor(a));
    sel.appendChild(og);
  }
  if (byCode.has(defaultCode)) sel.value = defaultCode;
}

function renderDestChips(): void {
  const ul = $('#dest-chips');
  ul.innerHTML = selectedDests
    .map((c) => `<li class="chip" data-code="${c}">${airportName(c)} ${c}<button type="button" aria-label="削除">×</button></li>`)
    .join('');
  ul.querySelectorAll<HTMLButtonElement>('.chip button').forEach((b) =>
    b.addEventListener('click', () => {
      const code = b.parentElement?.getAttribute('data-code');
      selectedDests = selectedDests.filter((d) => d !== code);
      renderDestChips();
      updateEstimate();
    }),
  );
}

function populateAirports(list: AnaAirportList): void {
  airportList = list;
  fillSelect($('#depart-select') as HTMLSelectElement, list, 'HND');
  fillSelect($('#dest-select') as HTMLSelectElement, list, 'GUM');
  renderDestChips();
}

// --- Port 接続 (サービスワーカー再起動で切れても自動再接続) ---------------
let port: chrome.runtime.Port | null = null;
function connectPanel(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: 'ana-panel' });
  p.onMessage.addListener((msg: SwToPanelMessage) => handleSw(msg));
  p.onDisconnect.addListener(() => { port = null; });
  port = p;
  return p;
}
function sendSw(msg: PanelToSwMessage): void {
  try {
    (port ?? connectPanel()).postMessage(msg);
  } catch {
    // ポートが死んでいたら張り直して再送
    port = connectPanel();
    try { port.postMessage(msg); } catch { /* noop */ }
  }
}
connectPanel();

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
  // 目的地: チップ(複数)があればそれ、無ければ目的地セレクトの現在値
  const destSel = ($('#dest-select') as HTMLSelectElement).value;
  const dests = selectedDests.length > 0 ? selectedDests.slice() : (destSel ? [destSel] : []);
  return {
    type: fd.get('type') === 'domestic' ? 'domestic' : 'international',
    depart: String(($('#depart-select') as HTMLSelectElement).value ?? '').trim().toUpperCase(),
    dest: dests[0] ?? '',
    dests,
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
    const nDest = cfg.dests?.length ?? 1;
    let note = `目的地 ${nDest} / 検索 ${jobs.length} 件 / 推定 約${mins}分`;
    if (jobs.length > 40) note += ' ⚠ 件数が多いとbot検知リスクが上がります';
    $('#estimate').textContent = note;
  } catch (e) {
    $('#estimate').textContent = (e as Error).message;
  }
}
$('#sweep-form').addEventListener('input', updateEstimate);

// --- 空港リスト初期化 (ANAページから取り込んだものがあれば使う) -----------
populateAirports(FALLBACK);
chrome.storage.local.get('anaAirports').then((v) => {
  const list = v.anaAirports as AnaAirportList | undefined;
  if (list && list.airports?.length) {
    populateAirports(list);
    ($('#airport-note') as HTMLElement).textContent = `ANAの全空港リスト(${list.airports.length}件)を使用中。`;
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.anaAirports?.newValue) {
    const list = changes.anaAirports.newValue as AnaAirportList;
    populateAirports(list);
    ($('#airport-note') as HTMLElement).textContent = `ANAの全空港リスト(${list.airports.length}件)を使用中。`;
  }
});

// --- 目的地の追加 (複数指定) ---------------------------------------------
$('#btn-add-dest').addEventListener('click', () => {
  const code = ($('#dest-select') as HTMLSelectElement).value;
  if (code && !selectedDests.includes(code)) {
    selectedDests.push(code);
    renderDestChips();
    updateEstimate();
  }
});

// --- 操作ボタン ----------------------------------------------------------
$('#sweep-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cfg = readConfig();
  if (!cfg.depart || !cfg.dest) return alert('出発空港と目的地を選択してください');
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
  // 開始は常に押せる (新規スイープは既存を停止してから開始する)
  ($('#btn-start') as HTMLButtonElement).disabled = false;
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

// --- 現在のANA結果ページを取り込んで解析 (旧国際線エンジン) ---------------
const CFF_CABIN: Record<string, Cabin> = {
  CFF1: 'ECONOMY', CFF4: 'PREMIUM_ECONOMY', CFF2: 'BUSINESS', CFF3: 'FIRST',
};
function ymd(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}
/** 結果ページHTMLから検索条件(出発日・復路日・キャビン)を推定 */
function deriveCtx(html: string): { outboundDate: string; returnDate: string; cabin: Cabin } {
  let outboundDate = '', returnDate = '', cabin: Cabin = 'ECONOMY';
  const m = /Asw\.SearchCriteriaOutput\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (m) {
    try {
      const sc = JSON.parse(m[1]);
      outboundDate = ymd(sc.requestedSegmentList?.[0]?.departureDateYyyyMMdd ?? '');
      returnDate = ymd(sc.requestedSegmentList?.[1]?.departureDateYyyyMMdd ?? '');
      cabin = CFF_CABIN[sc.cffCodeInput] ?? 'ECONOMY';
    } catch { /* noop */ }
  }
  return { outboundDate, returnDate, cabin };
}
$('#btn-import-page').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_PAGE_HTML' }, (res) => {
    if (!res || res.error) return alert('取得失敗: ' + (res?.error ?? '不明'));
    const doc = new DOMParser().parseFromString(res.html as string, 'text/html');
    const parsed = parseLegacyIntlResult(doc, deriveCtx(res.html as string));
    if (parsed.length === 0) {
      return alert('解析できる旅程が見つかりませんでした。\n国際線特典の「往復空席照会結果」ページを開いた状態でお試しください。');
    }
    rows = parsed;
    renderResults();
  });
});

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
