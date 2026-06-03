import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LegacySweepController, type LegacyHooks } from '../src/background/legacy-sweep';
import type { ResultRow, SweepConfig } from '../src/core/types';

const config: SweepConfig = {
  type: 'international',
  engine: 'legacy-intl',
  depart: 'OSA',
  dest: 'GUM',
  periodStart: '2026-11-05',
  periodEnd: '2026-11-07',
  weekdays: [],
  returnOffsetDays: 3,
  cabin: 'ECONOMY',
  throttle: { baseMs: 10, spreadMs: 0, longPauseEvery: 0, longPauseMs: 0 },
};

function row(out: string, ret: string): ResultRow {
  return {
    id: `${out}_${ret}`,
    outbound: { direction: 'OUT', date: out, segments: [], operatorType: 'ANA' },
    inbound: { direction: 'RET', date: ret, segments: [], operatorType: 'ANA' },
    totalMiles: 20000,
    fuelSurcharge: null,
    cabin: 'ECONOMY',
    type: 'international',
    capturedAt: '',
  };
}

interface Harness {
  hooks: LegacyHooks;
  submits: { out: string; ret: string; dest: string }[];
  rows: ResultRow[];
  runTimers: () => void;
}

function harness(): Harness {
  const submits: { out: string; ret: string; dest: string }[] = [];
  const rows: ResultRow[] = [];
  let pending: (() => void) | null = null;
  const hooks: LegacyHooks = {
    submit: (job) => submits.push({ out: job.outboundDate, ret: job.returnDate, dest: job.dest }),
    onRows: (r) => rows.push(...r),
    onProgress: () => void 0,
    persist: () => void 0,
    setTimer: (_ms, fn) => { pending = fn; },
    clearTimer: () => { pending = null; },
  };
  return { hooks, submits, rows, runTimers: () => { const p = pending; pending = null; p?.(); } };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('LegacySweepController', () => {
  it('開始で最初のジョブを投入する', () => {
    const h = harness();
    const c = new LegacySweepController(h.hooks, config);
    c.start();
    expect(h.submits).toEqual([{ out: '2026-11-05', ret: '2026-11-08', dest: 'GUM' }]);
    expect(c.getJobs()).toHaveLength(3);
  });

  it('結果ページ通知ごとに次のジョブへ進み、最後に done', () => {
    const h = harness();
    const c = new LegacySweepController(h.hooks, config);
    c.start();
    // job0
    c.onPageReady('2026-11-05', '2026-11-08', 'GUM', [row('2026-11-05', '2026-11-08')], true);
    h.runTimers(); // throttle 経過 → job1 投入
    // job1
    c.onPageReady('2026-11-06', '2026-11-09', 'GUM', [], true); // 空席なし
    h.runTimers();
    // job2
    c.onPageReady('2026-11-07', '2026-11-10', 'GUM', [row('2026-11-07', '2026-11-10')], true);
    expect(c.getState()).toBe('done');
    expect(h.submits.map((s) => s.out)).toEqual(['2026-11-05', '2026-11-06', '2026-11-07']);
    expect(h.rows).toHaveLength(2); // 空席なしの job1 は行なし
    const statuses = c.getJobs().map((j) => j.status);
    expect(statuses).toEqual(['done', 'empty', 'done']);
  });

  it('期待と異なる日付の通知は無視 (ユーザー操作/古いページ)', () => {
    const h = harness();
    const c = new LegacySweepController(h.hooks, config);
    c.start();
    c.onPageReady('2099-01-01', '2099-01-04', 'GUM', [row('x', 'y')], true);
    expect(c.getJobs()[0].status).toBe('running'); // 進んでいない
    expect(h.rows).toHaveLength(0);
  });

  it('タイムアウトでリトライし、上限超過で failed にして次へ', () => {
    const h = harness();
    const c = new LegacySweepController(h.hooks, config);
    c.start(); // submit#1 (attempt1)
    h.runTimers(); // timeout → submit#2 (attempt2)
    h.runTimers(); // timeout → submit#3 (attempt3)
    h.runTimers(); // timeout → attempts>=3 → failed, advance → throttle timer
    expect(c.getJobs()[0].status).toBe('failed');
    h.runTimers(); // throttle → submit job1
    expect(h.submits.filter((s) => s.out === '2026-11-05')).toHaveLength(3);
    expect(h.submits.some((s) => s.out === '2026-11-06')).toBe(true);
  });

  it('pause すると次の投入が止まる', () => {
    const h = harness();
    const c = new LegacySweepController(h.hooks, config);
    c.start();
    c.onPageReady('2026-11-05', '2026-11-08', 'GUM', [], true);
    c.pause();
    h.runTimers(); // throttle が来ても running でないので投入しない
    expect(c.getState()).toBe('paused');
    expect(h.submits).toHaveLength(1);
  });
});
