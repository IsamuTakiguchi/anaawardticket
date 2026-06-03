// ===========================================================================
// 正規化ヘルパー: 生 JSON の表記ゆれを共通のデータモデルへ寄せる。
// アダプタ (adapter-domestic / adapter-international) から共有利用する。
// すべてフェイルソフト: 不明値は安全側 (null / 既定値) に倒す。
// ===========================================================================

import type { Cabin, FuelSurcharge, OperatorType } from './types';

/** ANA グループとして扱う運航キャリアコード (= ANA運航便) */
const ANA_GROUP_CARRIERS = new Set(['NH', 'NQ', '7G']); // NH=ANA, NQ=AirJapan, 7G=スターフライヤー相当(暫定)

/**
 * "12,345" / "¥12,345" / "12345マイル" のような文字列・数値を number に変換。
 * 解釈できない場合は null。
 */
export function parseNumberLoose(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9.]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** 運航キャリア集合から ANA / PARTNER を判定 */
export function operatorTypeOf(operatingCarriers: string[]): OperatorType {
  const hasPartner = operatingCarriers.some(
    (c) => c && !ANA_GROUP_CARRIERS.has(c.toUpperCase()),
  );
  return hasPartner ? 'PARTNER' : 'ANA';
}

/** ANA 内部キャビンコード/表記 → Cabin。未知は ECONOMY にフォールバック */
export function normalizeCabin(raw: unknown): Cabin {
  const s = String(raw ?? '').toUpperCase();
  if (/(FIRST|FST|^F$|ファースト)/.test(s)) return 'FIRST';
  if (/(BUSINESS|BIZ|^[CJ]$|ビジネス)/.test(s)) return 'BUSINESS';
  if (/(PREMIUM|^[WE]$|プレミアム)/.test(s)) return 'PREMIUM_ECONOMY';
  return 'ECONOMY';
}

/**
 * 燃油サーチャージを正規化。0 / 不明は null を返す
 * (国内線や無料便を「サーチャージなし」として表現)。
 */
export function normalizeSurcharge(
  amount: unknown,
  currency: unknown = 'JPY',
): FuelSurcharge | null {
  const n = parseNumberLoose(amount);
  if (n == null || n <= 0) return null;
  return { amount: n, currency: String(currency || 'JPY') };
}

/**
 * 様々な時刻表記を "YYYY-MM-DDTHH:mm" へ寄せる。
 * date(YYYY-MM-DD) と time("0930" / "09:30") から組み立てるケースに対応。
 */
export function combineDateTime(date: string, time: unknown): string {
  const t = String(time ?? '').replace(/[^0-9]/g, '');
  if (t.length >= 4) {
    const hh = t.slice(0, 2);
    const mm = t.slice(2, 4);
    return `${date}T${hh}:${mm}`;
  }
  return `${date}T00:00`;
}
