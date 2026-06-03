// ===========================================================================
// 国際線特典航空券アダプタ (ANA / スターアライアンス提携便)。
// 全キャビン・提携運航・燃油サーチャージ・複数区間に対応。共通実装に委譲。
// ===========================================================================

import { adaptAvailability, type RawAvailabilityResponse } from './adapter';
import type { Cabin, ResultRow } from './types';

export function adaptInternational(
  raw: RawAvailabilityResponse,
  ctx: { outboundDate: string; returnDate: string; cabin: Cabin },
): ResultRow[] {
  return adaptAvailability(raw, 'international', ctx);
}
