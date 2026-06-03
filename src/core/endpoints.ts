// ===========================================================================
// 空席照会レスポンスかどうかの URL 判定。
// ANA は 2025 年に予約エンジンを刷新済み (aswbe.ana.co.jp/webapps/*)。
// 正確なパスは dev capture モードで実データを観察して絞り込む前提のため、
// 初期は緩めのパターンにしておき、判明したら厳格化する。
// ===========================================================================

import type { AwardType } from './types';

/** 空席照会らしき URL を示すパターン (緩め)。dev で確認後に厳格化する */
const AVAILABILITY_HINTS = [
  /availab/i,
  /vacanc/i,
  /award/i,
  /flight-?search/i,
  /searchFlight/i,
  /booking\/.*search/i,
  /空席/,
];

/** dev capture でも除外したいノイズ (静的アセット等) */
const NOISE = [
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map)(\?|$)/i,
  /google|gtm|analytics|doubleclick|adobe|optimizely/i,
];

export function isAnaHost(url: string): boolean {
  try {
    const h = new URL(url, 'https://aswbe.ana.co.jp').hostname;
    return h.endsWith('ana.co.jp');
  } catch {
    return false;
  }
}

export function isNoise(url: string): boolean {
  return NOISE.some((re) => re.test(url));
}

/** スイープ中に転送すべき「空席照会レスポンス」候補かどうか */
export function isAvailabilityCall(url: string): boolean {
  if (!isAnaHost(url) || isNoise(url)) return false;
  return AVAILABILITY_HINTS.some((re) => re.test(url));
}

/** URL からおおまかに国内/国際を推定 (確定はアダプタで行う) */
export function guessAwardType(url: string): AwardType | null {
  if (/dom(estic)?|国内/i.test(url)) return 'domestic';
  if (/int(ernational)?|国際/i.test(url)) return 'international';
  return null;
}
