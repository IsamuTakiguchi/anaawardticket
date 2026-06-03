// ===========================================================================
// 検索マトリクス生成: 期間 × 曜日 × 帰国オフセット → 検索ジョブ列
// 純粋関数のみ。chrome.* / Date のタイムゾーン依存を避けるため YYYY-MM-DD を
// UTC 正午基準で素朴に計算する (DST 非依存)。
// ===========================================================================

import type { SearchJob, SweepConfig, Weekday } from './types';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" を UTC 正午のエポックミリ秒に変換 */
export function dateToEpoch(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`不正な日付形式: ${ymd}`);
  const [, y, mo, d] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0);
}

/** エポックミリ秒を "YYYY-MM-DD" に変換 */
export function epochToDate(epoch: number): string {
  const d = new Date(epoch);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** 日付に日数を加算した "YYYY-MM-DD" を返す */
export function addDays(ymd: string, days: number): string {
  return epochToDate(dateToEpoch(ymd) + days * MS_PER_DAY);
}

/** 0=日曜 .. 6=土曜 */
export function weekdayOf(ymd: string): Weekday {
  return new Date(dateToEpoch(ymd)).getUTCDay() as Weekday;
}

/**
 * 期間内の出発日を列挙し、曜日フィルタを適用する。
 * weekdays が空配列の場合は全曜日を対象とする。
 */
export function enumerateOutboundDates(
  periodStart: string,
  periodEnd: string,
  weekdays: Weekday[],
): string[] {
  const start = dateToEpoch(periodStart);
  const end = dateToEpoch(periodEnd);
  if (end < start) return [];

  const allowAll = weekdays.length === 0;
  const allowed = new Set<number>(weekdays);
  const out: string[] = [];

  for (let t = start; t <= end; t += MS_PER_DAY) {
    const day = new Date(t).getUTCDay();
    if (allowAll || allowed.has(day)) {
      out.push(epochToDate(t));
    }
  }
  return out;
}

/** 安定したジョブ ID (目的地 + 往路日 + 復路日) */
export function jobId(dest: string, outboundDate: string, returnDate: string): string {
  return `${dest}_${outboundDate}_${returnDate}`;
}

/**
 * SweepConfig から検索ジョブ列を生成する。
 * 目的地 (dests があれば全て、なければ dest) × 出発日 の全組合せを作り、
 * 各出発日に returnOffsetDays を加算した復路日をペアにする。
 */
export function buildJobMatrix(config: SweepConfig): SearchJob[] {
  if (config.returnOffsetDays < 0) {
    throw new Error('returnOffsetDays は 0 以上である必要があります');
  }
  const outbounds = enumerateOutboundDates(
    config.periodStart,
    config.periodEnd,
    config.weekdays,
  );
  const dests = config.dests && config.dests.length > 0 ? config.dests : [config.dest];
  const jobs: SearchJob[] = [];
  for (const dest of dests) {
    for (const outboundDate of outbounds) {
      const returnDate = addDays(outboundDate, config.returnOffsetDays);
      jobs.push({
        id: jobId(dest, outboundDate, returnDate),
        outboundDate,
        returnDate,
        dest,
        status: 'pending',
        attempts: 0,
      });
    }
  }
  return jobs;
}
