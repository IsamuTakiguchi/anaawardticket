// ===========================================================================
// 結果テーブルのレンダリング・ソート・フィルタ。
// ===========================================================================

import type { Cabin, OperatorType, ResultRow } from '../core/types';

export type SortKey = 'miles' | 'surcharge' | 'date';
export type OperatorFilter = 'all' | 'ANA' | 'PARTNER';

export interface TableViewState {
  sortKey: SortKey;
  sortAsc: boolean;
  operator: OperatorFilter;
  cabin: Cabin | 'all';
  maxMiles: number | null;
  excludeWaitlist: boolean; // true で空席待ち(座席数0)を除外
}

export const DEFAULT_VIEW: TableViewState = {
  sortKey: 'miles',
  sortAsc: true,
  operator: 'all',
  cabin: 'all',
  maxMiles: null,
  excludeWaitlist: false,
};

function rowOperator(r: ResultRow): OperatorType {
  // 往復どちらかに提携便があれば PARTNER 扱い
  return r.outbound.operatorType === 'PARTNER' ||
    (r.inbound.segments.length > 0 && r.inbound.operatorType === 'PARTNER')
    ? 'PARTNER'
    : 'ANA';
}

/** 往路または復路の空席が 0 = 空席待ち */
function isWaitlist(r: ResultRow): boolean {
  return r.outbound.availableSeats === 0 || r.inbound.availableSeats === 0;
}

export function applyView(rows: ResultRow[], view: TableViewState): ResultRow[] {
  let out = rows.filter((r) => {
    if (view.operator !== 'all' && rowOperator(r) !== view.operator) return false;
    if (view.cabin !== 'all' && r.cabin !== view.cabin) return false;
    if (view.maxMiles != null && r.totalMiles > view.maxMiles) return false;
    if (view.excludeWaitlist && isWaitlist(r)) return false;
    return true;
  });

  out = out.slice().sort((a, b) => {
    let cmp = 0;
    switch (view.sortKey) {
      case 'miles':
        cmp = a.totalMiles - b.totalMiles;
        break;
      case 'surcharge':
        cmp = (a.fuelSurcharge?.amount ?? 0) - (b.fuelSurcharge?.amount ?? 0);
        break;
      case 'date':
        cmp = a.outbound.date.localeCompare(b.outbound.date) ||
          a.inbound.date.localeCompare(b.inbound.date);
        break;
    }
    return view.sortAsc ? cmp : -cmp;
  });
  return out;
}

function timeOnly(iso: string): string {
  return iso.includes('T') ? iso.split('T')[1] : iso;
}

function operatorBadge(t: OperatorType): string {
  return t === 'ANA'
    ? '<span class="badge ana">ANA</span>'
    : '<span class="badge partner">提携</span>';
}

/** 区間 (出発地→目的地) を往路セグメントから推定 */
function routeLabel(r: ResultRow): string {
  const segs = r.outbound.segments;
  if (segs.length === 0) return '—';
  const from = segs[0].depAirport;
  const to = segs[segs.length - 1].arrAirport;
  if (!from && !to) return '—';
  return `${from || '?'} → ${to || '?'}`;
}

function itineraryCell(r: ResultRow, dir: 'outbound' | 'inbound'): string {
  const it = r[dir];
  if (it.segments.length === 0) return '<td class="muted">—</td>';
  const first = it.segments[0];
  const last = it.segments[it.segments.length - 1];
  const carriers = it.segments
    .map((s) => {
      const code = `${s.operatingCarrier}${s.flightNumber}`;
      return s.carrierName ? `${s.carrierName} ${code}` : code;
    })
    .join(' → ');
  const stops = it.segments.length > 1 ? ` <span class="stops">(${it.segments.length - 1}回乗継)</span>` : '';
  return `<td>
    <div class="time">${timeOnly(first.depTime)}–${timeOnly(last.arrTime)}</div>
    <div class="flt">${operatorBadge(it.operatorType)} ${carriers}${stops}</div>
  </td>`;
}

export function renderTable(container: HTMLElement, rows: ResultRow[], view: TableViewState): void {
  const shown = applyView(rows, view);
  const arrow = (k: SortKey) => (view.sortKey === k ? (view.sortAsc ? ' ▲' : ' ▼') : '');

  if (rows.length === 0) {
    container.innerHTML = '<p class="empty-note">まだ結果がありません。条件を設定して検索を開始してください。</p>';
    return;
  }

  const head = `<thead><tr>
    <th>区間</th>
    <th data-sort="date" class="sortable">往路日${arrow('date')}</th>
    <th>復路日</th>
    <th>往路便</th>
    <th>復路便</th>
    <th>キャビン</th>
    <th data-sort="miles" class="sortable">必要マイル${arrow('miles')}</th>
    <th data-sort="surcharge" class="sortable">税金・燃油${arrow('surcharge')}</th>
  </tr></thead>`;

  const body = shown
    .map(
      (r) => `<tr>
        <td class="route">${routeLabel(r)}</td>
        <td>${r.outbound.date}</td>
        <td>${r.inbound.date}</td>
        ${itineraryCell(r, 'outbound')}
        ${itineraryCell(r, 'inbound')}
        <td>${cabinLabel(r.cabin)}</td>
        <td class="num">${r.totalMiles.toLocaleString()}</td>
        <td class="num">${r.fuelSurcharge ? '¥' + r.fuelSurcharge.amount.toLocaleString() : '—'}</td>
      </tr>`,
    )
    .join('');

  container.innerHTML = `<div class="count">${shown.length} / ${rows.length} 件表示</div>
    <table class="results">${head}<tbody>${body}</tbody></table>`;
}

function cabinLabel(c: Cabin): string {
  return { ECONOMY: 'エコノミー', PREMIUM_ECONOMY: 'プレエコ', BUSINESS: 'ビジネス', FIRST: 'ファースト' }[c];
}
