// ===========================================================================
// 共有アダプタ実装: ANA 空席照会の生 JSON → ResultRow[]
//
// ⚠ ANA の内部 API スキーマは非公開のため、フィールド名は field-keys.ts の
//   候補リストで吸収する (表記ゆれ耐性)。Phase 0 の dev capture で実キーが
//   判明したら field-keys.ts の各配列の先頭に実キーを足すだけで追従できる。
//   すべて pick / optional chaining + normalize ヘルパーでフェイルソフトに実装し、
//   未知フィールドは null / 既定値に倒してスイープを止めない。
// ===========================================================================

import type {
  AwardType,
  Cabin,
  FlightSegment,
  Itinerary,
  ResultRow,
} from './types';
import {
  combineDateTime,
  normalizeCabin,
  normalizeSurcharge,
  operatorTypeOf,
  parseNumberLoose,
} from './normalize';
import { KEYS, pick, pickArray, pickRecord, type AnyRec } from './field-keys';

// 想定スキーマ (ドキュメント用途 + フィクスチャの型付け)。実データは
// 必ずしもこの形ではないため、抽出は field-keys 経由で行う。
export interface RawSegment {
  marketingCarrier?: string;
  operatingCarrier?: string;
  flightNumber?: string | number;
  from?: string;
  to?: string;
  departureTime?: string | number;
  arrivalTime?: string | number;
  cabin?: string;
}
export interface RawOption {
  segments?: RawSegment[];
  available?: boolean;
  seats?: number | null;
  requiredMiles?: number | string;
  fuelSurcharge?: { amount?: number | string; currency?: string } | number | string;
  cabin?: string;
}
export interface RawDirection {
  date?: string;
  options?: RawOption[];
}
export interface RawAvailabilityResponse {
  awardType?: AwardType;
  pricing?: {
    requiredMiles?: number | string;
    fuelSurcharge?: { amount?: number | string; currency?: string } | number | string;
  };
  outbound?: RawDirection;
  inbound?: RawDirection;
}

const MAX_PAIRS = 60; // 1 ジョブあたりの行数上限 (組み合わせ爆発防止)

function toSegment(raw: AnyRec, date: string, fallbackCabin: Cabin): FlightSegment {
  const mk = String(pick(raw, KEYS.marketingCarrier) ?? '').toUpperCase();
  const flightNo = String(pick(raw, KEYS.flightNumber) ?? '');
  let op = String(pick(raw, KEYS.operatingCarrier) ?? '').toUpperCase();
  if (!op) {
    // 運航会社フィールドが無い場合、便名の先頭2文字から推定 (NH### = ANA, UA/LH 等 = 提携)
    const m = /^([A-Za-z]{2})/.exec(flightNo);
    op = m ? m[1].toUpperCase() : mk;
  }
  const cabinRaw = pick(raw, KEYS.cabin);
  return {
    marketingCarrier: mk || op,
    operatingCarrier: op || mk,
    flightNumber: flightNo,
    depAirport: String(pick(raw, KEYS.from) ?? ''),
    arrAirport: String(pick(raw, KEYS.to) ?? ''),
    depTime: combineDateTime(date, pick(raw, KEYS.departureTime)),
    arrTime: combineDateTime(date, pick(raw, KEYS.arrivalTime)),
    cabin: cabinRaw != null ? normalizeCabin(cabinRaw) : fallbackCabin,
  };
}

function optionToItinerary(
  raw: AnyRec,
  date: string,
  direction: 'OUT' | 'RET',
  fallbackCabin: Cabin,
): Itinerary {
  const segs = pickArray(raw, KEYS.segments).map((s) => toSegment(s, date, fallbackCabin));
  const seats = parseNumberLoose(pick(raw, KEYS.seats));
  return {
    direction,
    date,
    segments: segs,
    operatorType: operatorTypeOf(segs.map((s) => s.operatingCarrier)),
    availableSeats: seats,
  };
}

function isAvailable(raw: AnyRec): boolean {
  const flag = pick(raw, KEYS.available);
  if (typeof flag === 'boolean') return flag;
  const seats = parseNumberLoose(pick(raw, KEYS.seats));
  if (seats != null) return seats > 0;
  // どちらも不明なら「候補として返ってきた = 空席あり」とみなす (フェイルソフト)
  return true;
}

function surchargeOf(raw: unknown): ReturnType<typeof normalizeSurcharge> {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const rec = raw as AnyRec;
    return normalizeSurcharge(pick(rec, KEYS.amount) ?? rec, pick(rec, KEYS.currency));
  }
  return normalizeSurcharge(raw);
}

/**
 * 想定/実スキーマの生 JSON を ResultRow[] に変換する共通ロジック。
 */
export function adaptAvailability(
  raw: RawAvailabilityResponse | AnyRec,
  type: AwardType,
  ctx: { outboundDate: string; returnDate: string; cabin: Cabin },
): ResultRow[] {
  const root = (raw ?? {}) as AnyRec;
  const capturedAt = new Date().toISOString();

  const outDir = pickRecord(root, KEYS.outbound);
  const inDir = pickRecord(root, KEYS.inbound);
  const outDate = (pick(outDir, KEYS.date) as string) ?? ctx.outboundDate;
  const retDate = (pick(inDir, KEYS.date) as string) ?? ctx.returnDate;

  const outOpts = pickArray(outDir, KEYS.options).filter(isAvailable);
  const inOpts = pickArray(inDir, KEYS.options).filter(isAvailable);

  // 往復一括 pricing があればそれを優先採用
  const pricing = pickRecord(root, KEYS.pricing);
  const zoneMiles = parseNumberLoose(pick(pricing, KEYS.requiredMiles));
  const zoneSurcharge = pricing ? surchargeOf(pick(pricing, KEYS.fuelSurcharge)) : null;

  // 復路候補が無くても往路だけで行を作れるようにする
  const inboundList: (AnyRec | null)[] = inOpts.length > 0 ? inOpts : [null];

  const rows: ResultRow[] = [];
  outer: for (const o of outOpts) {
    for (const i of inboundList) {
      if (rows.length >= MAX_PAIRS) break outer;

      const outbound = optionToItinerary(o, outDate, 'OUT', ctx.cabin);
      const inbound = i
        ? optionToItinerary(i, retDate, 'RET', ctx.cabin)
        : ({ direction: 'RET', date: retDate, segments: [], operatorType: 'ANA', availableSeats: null } as Itinerary);

      // マイル: zone 優先 → 各 option の合計
      const optMiles =
        (parseNumberLoose(pick(o, KEYS.requiredMiles)) ?? 0) +
        (i ? parseNumberLoose(pick(i, KEYS.requiredMiles)) ?? 0 : 0);
      const totalMiles = zoneMiles ?? optMiles;

      // サーチャージ: zone 優先 → option 合算
      let fuelSurcharge = zoneSurcharge;
      if (!fuelSurcharge) {
        const oS = surchargeOf(pick(o, KEYS.fuelSurcharge));
        const iS = i ? surchargeOf(pick(i, KEYS.fuelSurcharge)) : null;
        const sum = (oS?.amount ?? 0) + (iS?.amount ?? 0);
        fuelSurcharge = normalizeSurcharge(sum, oS?.currency ?? iS?.currency ?? 'JPY');
      }

      const cabin = outbound.segments[0]?.cabin ?? ctx.cabin;

      rows.push({
        id: `${outDate}_${retDate}_${rows.length}`,
        outbound,
        inbound,
        totalMiles,
        fuelSurcharge,
        cabin,
        type,
        capturedAt,
      });
    }
  }
  return rows;
}
