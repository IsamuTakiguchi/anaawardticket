// ===========================================================================
// 結果行を CSV (Excel 互換: UTF-8 BOM 付き) に変換しダウンロードする。
// ===========================================================================

import type { ResultRow } from '../core/types';

const HEADER = [
  '往路日',
  '復路日',
  '往路出発',
  '往路到着',
  '復路出発',
  '復路到着',
  '運航',
  '往路航空会社',
  '復路航空会社',
  'キャビン',
  '必要マイル',
  '税金・燃油',
  '路線種別',
];

/** 旅程の便を "ANA NH412 → ユナイテッド航空 UA184" のように連結 */
function flightsLabel(it: { segments: { operatingCarrier: string; flightNumber: string; carrierName?: string }[] }): string {
  return it.segments
    .map((s) => {
      const code = `${s.operatingCarrier}${s.flightNumber}`;
      return s.carrierName ? `${s.carrierName} ${code}` : code;
    })
    .join(' / ');
}

function esc(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function time(iso: string): string {
  // "YYYY-MM-DDTHH:mm" → "HH:mm"
  return iso.includes('T') ? iso.split('T')[1] : iso;
}

function operatorLabel(row: ResultRow): string {
  const o = row.outbound.operatorType;
  const i = row.inbound.segments.length ? row.inbound.operatorType : o;
  return o === i ? (o === 'ANA' ? 'ANA' : '提携') : `${o === 'ANA' ? 'ANA' : '提携'}/${i === 'ANA' ? 'ANA' : '提携'}`;
}

export function rowsToCsv(rows: ResultRow[]): string {
  const lines = [HEADER.map(esc).join(',')];
  for (const r of rows) {
    const out0 = r.outbound.segments[0];
    const outN = r.outbound.segments[r.outbound.segments.length - 1];
    const in0 = r.inbound.segments[0];
    const inN = r.inbound.segments[r.inbound.segments.length - 1];
    lines.push(
      [
        r.outbound.date,
        r.inbound.date,
        out0 ? time(out0.depTime) : '',
        outN ? time(outN.arrTime) : '',
        in0 ? time(in0.depTime) : '',
        inN ? time(inN.arrTime) : '',
        operatorLabel(r),
        flightsLabel(r.outbound),
        flightsLabel(r.inbound),
        r.cabin,
        r.totalMiles,
        r.fuelSurcharge ? `${r.fuelSurcharge.amount}${r.fuelSurcharge.currency}` : '0',
        r.type === 'domestic' ? '国内' : '国際',
      ]
        .map(esc)
        .join(','),
    );
  }
  return lines.join('\n');
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  // CSV は Excel 互換のため BOM を付与
  const body = mime.includes('csv') ? '﻿' + text : text;
  const blob = new Blob([body], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
