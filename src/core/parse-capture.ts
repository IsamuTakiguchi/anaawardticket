// ===========================================================================
// キャプチャ (RawCapture) → ResultRow[] へのディスパッチ。
// JSON パースに失敗してもスイープを止めず空配列を返す (フェイルソフト)。
// ===========================================================================

import type { AwardType, Cabin, RawCapture, ResultRow } from './types';
import type { RawAvailabilityResponse } from './adapter';
import { adaptDomestic } from './adapter-domestic';
import { adaptInternational } from './adapter-international';
import { guessAwardType } from './endpoints';

export interface ParseContext {
  outboundDate: string;
  returnDate: string;
  cabin: Cabin;
  /** 検索条件で指定された種別 (URL 推定より優先) */
  type: AwardType;
}

export function parseCapture(capture: RawCapture, ctx: ParseContext): ResultRow[] {
  let raw: RawAvailabilityResponse;
  try {
    raw = JSON.parse(capture.body) as RawAvailabilityResponse;
  } catch {
    console.warn('[ana-sweep] JSON パース失敗:', capture.url);
    return [];
  }

  // 種別: 条件指定 > レスポンス内 > URL 推定
  const type: AwardType =
    ctx.type ?? raw.awardType ?? guessAwardType(capture.url) ?? 'international';

  try {
    return type === 'domestic' ? adaptDomestic(raw, ctx) : adaptInternational(raw, ctx);
  } catch (e) {
    console.warn('[ana-sweep] アダプタ変換失敗:', e);
    return [];
  }
}
