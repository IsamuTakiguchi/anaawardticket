// ===========================================================================
// 共有アダプタ実装: ANA 空席照会の生 JSON → ResultRow[]
//
// ⚠ ANA の内部 API スキーマは非公開のため、ここで定義する RawAvailability* は
//   「想定スキーマ」である。Phase 0 の dev capture で実データを取得後、
//   このファイル (とフィールド名の取り出し箇所) を実スキーマに合わせて更新する。
//   すべて optional chaining + normalize ヘルパーでフェイルソフトに実装し、
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

// --- 想定する生スキーマ (dev capture 後に要調整) ------------------------

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
  /** この方向 / 旅程の必要マイル (往復一括で来る場合は pricing 側を使う) */
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
  /** 往復一括の必要マイル・サーチャージ (ゾーン制特典で来る場合) */
  pricing?: {
    requiredMiles?: number | string;
    fuelSurcharge?: { amount?: number | string; currency?: string } | number | string;
  };
  outbound?: RawDirection;
  inbound?: RawDirection;
}

// --- 変換処理 -------------------------------------------------------------

const MAX_PAIRS = 60; // 1 ジョブあたりの行数上限 (組み合わせ爆発防止)

function toSegment(raw: RawSegment, date: string, fallbackCabin: Cabin): FlightSegment {
  const mk = String(raw.marketingCarrier ?? '').toUpperCase();
  const op = String(raw.operatingCarrier ?? mk).toUpperCase();
  return {
    marketingCarrier: mk,
    operatingCarrier: op,
    flightNumber: String(raw.flightNumber ?? ''),
    depAirport: String(raw.from ?? ''),
    arrAirport: String(raw.to ?? ''),
    depTime: combineDateTime(date, raw.departureTime),
    arrTime: combineDateTime(date, raw.arrivalTime),
    cabin: raw.cabin ? normalizeCabin(raw.cabin) : fallbackCabin,
  };
}

function optionToItinerary(
  raw: RawOption,
  date: string,
  direction: 'OUT' | 'RET',
  fallbackCabin: Cabin,
): Itinerary {
  const segs = (raw.segments ?? []).map((s) => toSegment(s, date, fallbackCabin));
  return {
    direction,
    date,
    segments: segs,
    operatorType: operatorTypeOf(segs.map((s) => s.operatingCarrier)),
    availableSeats: raw.seats ?? null,
  };
}

function isAvailable(raw: RawOption): boolean {
  // available フラグが明示されていればそれを、なければ座席数 > 0 を空席とみなす
  if (typeof raw.available === 'boolean') return raw.available;
  const seats = raw.seats ?? null;
  if (seats != null) return seats > 0;
  // どちらも不明なら「候補として返ってきた = 空席あり」とみなす (フェイルソフト)
  return true;
}

function surchargeOf(raw: RawOption['fuelSurcharge']): ReturnType<typeof normalizeSurcharge> {
  if (raw == null) return null;
  if (typeof raw === 'object') return normalizeSurcharge(raw.amount, raw.currency);
  return normalizeSurcharge(raw);
}

/**
 * 想定スキーマの生 JSON を ResultRow[] に変換する共通ロジック。
 * @param raw    パース済み生 JSON
 * @param type   国内/国際 (URL からの推定値を上書きに使用)
 * @param ctx    ジョブの日付ペア (生 JSON に日付が無い場合のフォールバック)
 */
export function adaptAvailability(
  raw: RawAvailabilityResponse,
  type: AwardType,
  ctx: { outboundDate: string; returnDate: string; cabin: Cabin },
): ResultRow[] {
  const capturedAt = new Date().toISOString();
  const outDate = raw.outbound?.date ?? ctx.outboundDate;
  const retDate = raw.inbound?.date ?? ctx.returnDate;

  const outOpts = (raw.outbound?.options ?? []).filter(isAvailable);
  const inOpts = (raw.inbound?.options ?? []).filter(isAvailable);

  // 往復一括 pricing があればそれを優先採用
  const zoneMiles = parseNumberLoose(raw.pricing?.requiredMiles);
  const zoneSurcharge = raw.pricing ? surchargeOf(raw.pricing.fuelSurcharge) : null;

  // 復路候補が無い検索 (片道や復路未取得) でも往路だけで行を作れるようにする
  const inboundList: (RawOption | null)[] = inOpts.length > 0 ? inOpts : [null];

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
        (parseNumberLoose(o.requiredMiles) ?? 0) +
        (i ? parseNumberLoose(i.requiredMiles) ?? 0 : 0);
      const totalMiles = zoneMiles ?? optMiles;

      // サーチャージ: zone 優先 → option 合算
      let fuelSurcharge = zoneSurcharge;
      if (!fuelSurcharge) {
        const oS = surchargeOf(o.fuelSurcharge);
        const iS = i ? surchargeOf(i.fuelSurcharge) : null;
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
