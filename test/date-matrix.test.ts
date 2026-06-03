import { describe, it, expect } from 'vitest';
import {
  addDays,
  buildJobMatrix,
  enumerateOutboundDates,
  weekdayOf,
} from '../src/core/date-matrix';
import type { SweepConfig } from '../src/core/types';

describe('date-matrix', () => {
  it('addDays が月跨ぎを正しく扱う', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026は平年
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('weekdayOf は 0=日 .. 6=土', () => {
    expect(weekdayOf('2026-06-07')).toBe(0); // 日曜
    expect(weekdayOf('2026-06-08')).toBe(1); // 月曜
    expect(weekdayOf('2026-06-13')).toBe(6); // 土曜
  });

  it('曜日フィルタ: 空集合は全日', () => {
    const all = enumerateOutboundDates('2026-06-01', '2026-06-07', []);
    expect(all).toHaveLength(7);
  });

  it('曜日フィルタ: 土日のみ抽出', () => {
    const we = enumerateOutboundDates('2026-06-01', '2026-06-14', [0, 6]);
    expect(we).toEqual(['2026-06-06', '2026-06-07', '2026-06-13', '2026-06-14']);
  });

  it('終了 < 開始 は空配列', () => {
    expect(enumerateOutboundDates('2026-06-10', '2026-06-01', [])).toEqual([]);
  });

  it('buildJobMatrix: オフセットが月を跨ぐ', () => {
    const cfg: SweepConfig = {
      type: 'international',
      depart: 'HND',
      dest: 'HNL',
      periodStart: '2026-01-30',
      periodEnd: '2026-01-31',
      weekdays: [],
      returnOffsetDays: 5,
      cabin: 'BUSINESS',
    };
    const jobs = buildJobMatrix(cfg);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ outboundDate: '2026-01-30', returnDate: '2026-02-04', dest: 'HNL', status: 'pending' });
    expect(jobs[1]).toMatchObject({ outboundDate: '2026-01-31', returnDate: '2026-02-05' });
    expect(jobs[0].id).toBe('HNL_BUSINESS_2026-01-30_2026-02-04');
  });

  it('buildJobMatrix: 複数クラス × 複数目的地 × 日付 の全組合せ', () => {
    const cfg: SweepConfig = {
      type: 'international', depart: 'HND', dest: 'HNL',
      dests: ['HNL', 'GUM'], cabins: ['ECONOMY', 'BUSINESS'],
      periodStart: '2026-01-30', periodEnd: '2026-01-31',
      weekdays: [], returnOffsetDays: 5, cabin: 'ECONOMY',
    };
    const jobs = buildJobMatrix(cfg);
    expect(jobs).toHaveLength(8); // 2クラス × 2目的地 × 2日
    expect(jobs.filter((j) => j.cabin === 'BUSINESS')).toHaveLength(4);
    expect(jobs.filter((j) => j.cabin === 'ECONOMY' && j.dest === 'GUM')).toHaveLength(2);
  });

  it('buildJobMatrix: 複数目的地 × 日付 の全組合せ', () => {
    const cfg: SweepConfig = {
      type: 'international',
      depart: 'HND',
      dest: 'HNL',
      dests: ['HNL', 'GUM'],
      periodStart: '2026-01-30',
      periodEnd: '2026-01-31',
      weekdays: [],
      returnOffsetDays: 5,
      cabin: 'BUSINESS',
    };
    const jobs = buildJobMatrix(cfg);
    expect(jobs).toHaveLength(4); // 2目的地 × 2日
    expect(jobs.filter((j) => j.dest === 'HNL')).toHaveLength(2);
    expect(jobs.filter((j) => j.dest === 'GUM')).toHaveLength(2);
    expect(jobs[2]).toMatchObject({ dest: 'GUM', outboundDate: '2026-01-30' });
  });

  it('returnOffsetDays が負だと例外', () => {
    const cfg: SweepConfig = {
      type: 'domestic', depart: 'HND', dest: 'OKA',
      periodStart: '2026-06-01', periodEnd: '2026-06-02',
      weekdays: [], returnOffsetDays: -1, cabin: 'ECONOMY',
    };
    expect(() => buildJobMatrix(cfg)).toThrow();
  });
});
