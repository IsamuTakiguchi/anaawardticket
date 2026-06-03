// ===========================================================================
// 国内線特典航空券アダプタ。
// 国内線は燃油サーチャージが無く、キャビンも限定的。共通実装に委譲したうえで
// 国内線固有の正規化 (サーチャージを強制 null 化) を行う。
// ===========================================================================

import { adaptAvailability, type RawAvailabilityResponse } from './adapter';
import type { Cabin, ResultRow } from './types';

export function adaptDomestic(
  raw: RawAvailabilityResponse,
  ctx: { outboundDate: string; returnDate: string; cabin: Cabin },
): ResultRow[] {
  const rows = adaptAvailability(raw, 'domestic', ctx);
  // 国内線特典には燃油サーチャージが存在しないため明示的に null へ
  for (const r of rows) r.fuelSurcharge = null;
  return rows;
}
