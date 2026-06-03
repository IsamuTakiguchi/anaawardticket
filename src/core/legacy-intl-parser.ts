// ===========================================================================
// 旧国際線エンジン (aswbe-i.ana.co.jp/.../award_search_roundtrip_result_owd.xhtml)
// の結果ページパーサー。
//
// このエンジンは結果を JSON ではなくサーバーレンダリングHTMLに埋め込む。
// 実データ (DevTools の View Source) の構造に基づき以下を抽出する:
//   - 往路/復路の各旅程: .itinModeAvailabilityResult (空港・時刻・便名・ANA/提携)
//   - 必要マイル/空席数/税金: 埋め込みJSの addRecommendation(...) 呼び出し
//     例) addRecommendation(rank, outId, inId, outFF, inFF, null, null, total,
//            bool, _, _, requiredMiles, rule, rule, outSeats, inSeats, tax, ...)
//   - 往路と復路は radio の data-value (内部ID) で突き合わせる
//
// DOM 解析には Document が必要。呼び出し側 (content script / panel) が
// DOMParser でパースして渡す。テストは jsdom の Document を渡す。
// ===========================================================================

import type { Cabin, FlightSegment, Itinerary, ResultRow } from './types';
import { operatorTypeOf, normalizeSurcharge, combineDateTime } from './normalize';

export interface LegacyParseContext {
  outboundDate: string; // YYYY-MM-DD
  returnDate: string; // YYYY-MM-DD
  cabin: Cabin;
}

interface Recommendation {
  outboundId: string;
  inboundId: string;
  requiredMiles: number;
  outboundSeats: number | null;
  inboundSeats: number | null;
  taxYen: number;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** "21:50" や "04:50翌日" から "HH:mm" を取り出す */
function timeOf(raw: string): string {
  const m = /(\d{1,2}:\d{2})/.exec(raw);
  return m ? m[1] : '';
}

/** 便名 "UA150" を取り出す */
function flightNoOf(detail: Element | null): string {
  const spans = detail?.querySelectorAll('span') ?? [];
  for (const s of Array.from(spans)) {
    const m = /\b([A-Z]{2}\d{1,4})\b/.exec(text(s));
    if (m) return m[1];
  }
  return '';
}

/** 運航航空会社名を取り出す ("ユナイテッド航空運航"→"ユナイテッド航空", ANA運航便アイコン→"ANA") */
function carrierNameOf(detail: Element | null): string {
  // 「○○運航」テキスト (提携便・ANAウイングス等。より具体的なので優先)
  for (const el of Array.from(detail?.querySelectorAll('a, span') ?? [])) {
    const t = text(el);
    const m = /^(.+?)運航$/.exec(t);
    if (m && m[1]) return m[1];
  }
  // ANA運航便 / スターアライアンス加盟航空会社便 アイコンの alt
  const img = detail?.querySelector('img[alt$="運航便"]');
  if (img) return (img.getAttribute('alt') ?? '').replace(/運航便$/, '');
  return '';
}

/** 1 つの .itinModeAvailabilityResult から Itinerary を作る */
function parseItinerary(
  el: Element,
  direction: 'OUT' | 'RET',
  date: string,
  cabin: Cabin,
): { id: string; itinerary: Itinerary } | null {
  const radio = el.querySelector('i[role="button"][data-value]');
  const id = radio?.getAttribute('data-value') ?? '';
  if (id === '') return null;

  const segments: FlightSegment[] = [];
  // 各セグメントは .flightSchedule とその兄弟 .detailInformation を持つ td
  const tds = Array.from(el.querySelectorAll('.timeSchedule td'));
  for (const td of tds) {
    const sched = td.querySelector('.flightSchedule');
    if (!sched) continue;
    const detail = td.querySelector('.detailInformation');
    const dirs = sched.querySelectorAll(':scope > div');
    const depDiv = dirs[0];
    const arrDiv = dirs[1];
    const depAirport = text(depDiv?.querySelector('.airportDeparture'));
    const arrAirport = text(arrDiv?.querySelector('.airportArrival span')) || text(arrDiv?.querySelector('.airportArrival'));
    const depTime = timeOf(text(depDiv?.querySelector('.timeDeparture')));
    const arrTime = timeOf(text(arrDiv?.querySelector('.timeArrival')));
    const flightNo = flightNoOf(detail);
    const carrier = /^([A-Z]{2})/.exec(flightNo)?.[1] ?? '';
    segments.push({
      marketingCarrier: carrier,
      operatingCarrier: carrier,
      carrierName: carrierNameOf(detail),
      flightNumber: flightNo.replace(/^[A-Z]{2}/, ''),
      depAirport,
      arrAirport,
      depTime: combineDateTime(date, depTime),
      arrTime: combineDateTime(date, arrTime),
      cabin,
    });
  }
  if (segments.length === 0) return null;

  const itinerary: Itinerary = {
    direction,
    date,
    segments,
    operatorType: operatorTypeOf(segments.map((s) => s.operatingCarrier)),
  };
  return { id, itinerary };
}

const NUM = (s: string) => {
  const n = Number(String(s).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * addFormatedRecommendation(...) から表示用の税金・料金(円)を順番に抽出する。
 * 例: 引数中の '0円～' / '15,400円～' → 0 / 15400。addRecommendation と同順で対応。
 */
function parseFormattedTax(scriptText: string): number[] {
  const out: number[] = [];
  const re = /addFormatedRecommendation\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scriptText)) !== null) {
    const yen = /([\d,]+)\s*円/.exec(m[1]);
    out.push(yen ? NUM(yen[1]) : 0);
  }
  return out;
}

/** 埋め込みJSの addRecommendation(...) を抽出 (税金は表示文字列を優先) */
function parseRecommendations(scriptText: string): Recommendation[] {
  const formattedTax = parseFormattedTax(scriptText);
  const recs: Recommendation[] = [];
  const re = /addRecommendation\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(scriptText)) !== null) {
    const argsStr = m[1];
    // segmentInfoList の配列(末尾) より前の引数だけを使う
    const head = argsStr.slice(0, argsStr.indexOf('['));
    const tokens = (head === '' ? argsStr : head).split(',').map((t) => t.trim());
    if (tokens.length < 17) continue;
    // 税金・料金: 表示文字列(円)を優先、無ければ数値引数(index16)
    const taxYen = i < formattedTax.length ? formattedTax[i] : NUM(tokens[16]);
    recs.push({
      outboundId: tokens[1].replace(/['"]/g, ''),
      inboundId: tokens[2].replace(/['"]/g, ''),
      requiredMiles: NUM(tokens[11]),
      outboundSeats: tokens[14] !== undefined ? NUM(tokens[14]) : null,
      inboundSeats: tokens[15] !== undefined ? NUM(tokens[15]) : null,
      taxYen,
    });
    i++;
  }
  return recs;
}

function scriptTextOf(doc: Document): string {
  return Array.from(doc.querySelectorAll('script'))
    .map((s) => s.textContent ?? '')
    .join('\n');
}

/**
 * 旧国際線エンジンの結果ページ Document を ResultRow[] に変換する。
 * recommendation (往路ID×復路ID×必要マイル×空席×税金) を軸に、対応する
 * 往路/復路 itinerary を突き合わせて 1 行ずつ生成する。
 */
export function parseLegacyIntlResult(doc: Document, ctx: LegacyParseContext): ResultRow[] {
  const outMap = new Map<string, Itinerary>();
  const inMap = new Map<string, Itinerary>();

  for (const el of Array.from(doc.querySelectorAll('.selectItineraryOutbound .itinModeAvailabilityResult'))) {
    const r = parseItinerary(el, 'OUT', ctx.outboundDate, ctx.cabin);
    if (r) outMap.set(r.id, r.itinerary);
  }
  for (const el of Array.from(doc.querySelectorAll('.selectItineraryInbound .itinModeAvailabilityResult'))) {
    const r = parseItinerary(el, 'RET', ctx.returnDate, ctx.cabin);
    if (r) inMap.set(r.id, r.itinerary);
  }

  const recs = parseRecommendations(scriptTextOf(doc));
  const capturedAt = new Date().toISOString();
  const rows: ResultRow[] = [];

  for (const rec of recs) {
    const outbound = outMap.get(rec.outboundId);
    const inbound = inMap.get(rec.inboundId);
    if (!outbound || !inbound) continue;

    // 往復どちらかに提携便があれば PARTNER (results-table 側で再判定するため
    // ここでは outbound/inbound 各々の operatorType をそのまま保持する)
    rows.push({
      id: `${rec.outboundId}_${rec.inboundId}`,
      outbound: { ...outbound, availableSeats: rec.outboundSeats },
      inbound: { ...inbound, availableSeats: rec.inboundSeats },
      totalMiles: rec.requiredMiles,
      fuelSurcharge: normalizeSurcharge(rec.taxYen, 'JPY'),
      cabin: ctx.cabin,
      type: 'international',
      capturedAt,
    });
  }
  return rows;
}
