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

/**
 * ANA 内部キャビンコード/表記 → Cabin。未知は ECONOMY にフォールバック。
 * ANA の特典運賃区分コード (FS/CS/WS/YS = First/Business/Premium economy/Economy
 * の各 "saver" award) にも対応 (flightplan nh エンジンより)。
 */
export function normalizeCabin(raw: unknown): Cabin {
  const s = String(raw ?? '').toUpperCase();
  if (/(^FS$|FIRST|FST|^F$|ファースト)/.test(s)) return 'FIRST';
  if (/(^CS$|BUSINESS|BIZ|^[CJ]$|ビジネス)/.test(s)) return 'BUSINESS';
  if (/(^WS$|PREMIUM|^[WE]$|プレミアム|プレエコ)/.test(s)) return 'PREMIUM_ECONOMY';
  return 'ECONOMY'; // YS / Y / その他
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
 * 対応する入力例:
 *   - 完全な ISO 日時 "2026-09-10T21:25:00" / "2026-09-10 21:25"
 *   - "09:30"
 *   - "0930" / "930"
 * 完全日時が来た場合はその日付を優先し、無ければ fallbackDate を使う。
 */
export function combineDateTime(fallbackDate: string, time: unknown): string {
  const s = String(time ?? '');
  // 完全な日時 (日付込み)
  const iso = /(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):?(\d{2})/.exec(s);
  if (iso) return `${iso[1]}T${iso[2].padStart(2, '0')}:${iso[3]}`;
  // HH:mm
  const hm = /(\d{1,2}):(\d{2})/.exec(s);
  if (hm) return `${fallbackDate}T${hm[1].padStart(2, '0')}:${hm[2]}`;
  // HHMM / HMM (連続数字)
  const digits = s.replace(/[^0-9]/g, '');
  if (digits.length >= 3) {
    const padded = digits.padStart(4, '0').slice(0, 4);
    return `${fallbackDate}T${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }
  return `${fallbackDate}T00:00`;
}
