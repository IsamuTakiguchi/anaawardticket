import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SweepOrchestrator, type OrchestratorHooks } from '../src/background/sweep-orchestrator';
import type { RawCapture, ResultRow, SearchJob, SweepConfig } from '../src/core/types';

// Date.now をフェイク化し、注入 sleep でクロックを進める
let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => vi.restoreAllMocks());

const config: SweepConfig = {
  type: 'international',
  depart: 'HND',
  dest: 'HNL',
  periodStart: '2026-09-10',
  periodEnd: '2026-09-11',
  weekdays: [],
  returnOffsetDays: 7,
  cabin: 'BUSINESS',
  throttle: { baseMs: 100, spreadMs: 0, longPauseEvery: 0, longPauseMs: 0 },
};

function captureFor(outDate: string, retDate: string): RawCapture {
  return {
    url: 'https://aswbe.ana.co.jp/webapps/availability',
    method: 'GET',
    status: 200,
    capturedAt: new Date().toISOString(),
    body: JSON.stringify({
      awardType: 'international',
      pricing: { requiredMiles: 75000, fuelSurcharge: { amount: 0, currency: 'JPY' } },
      outbound: { date: outDate, options: [{ available: true, seats: 4, cabin: 'BUSINESS', segments: [{ operatingCarrier: 'NH', flightNumber: '182', from: 'HND', to: 'HNL', departureTime: '2125', arrivalTime: '1015', cabin: 'BUSINESS' }] }] },
      inbound: { date: retDate, options: [{ available: true, seats: 6, cabin: 'BUSINESS', segments: [{ operatingCarrier: 'NH', flightNumber: '183', from: 'HNL', to: 'HND', departureTime: '1145', arrivalTime: '1620', cabin: 'BUSINESS' }] }] },
    }),
  };
}

function makeHooks(overrides: Partial<OrchestratorHooks> = {}): {
  hooks: OrchestratorHooks;
  rows: ResultRow[];
  searchOrder: string[];
} {
  const rows: ResultRow[] = [];
  const searchOrder: string[] = [];
  const hooks: OrchestratorHooks = {
    runSearch: (job) => searchOrder.push(job.id),
    onRows: (r) => rows.push(...r),
    onProgress: () => void 0,
    persist: () => void 0,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    ...overrides,
  };
  return { hooks, rows, searchOrder };
}

describe('SweepOrchestrator', () => {
  it('全ジョブを逐次実行し結果をパースする', async () => {
    const { hooks, rows, searchOrder } = makeHooks();
    let orch!: SweepOrchestrator;
    // 検索指示と同時にキャプチャを供給
    const realRunSearch = (job: SearchJob) => {
      searchOrder.push(job.id);
      orch.acceptCapture(captureFor(job.outboundDate, job.returnDate));
    };
    orch = new SweepOrchestrator({ ...hooks, runSearch: realRunSearch }, config);

    await orch.run();

    expect(orch.getState()).toBe('done');
    expect(searchOrder).toEqual(['HNL_2026-09-10_2026-09-17', 'HNL_2026-09-11_2026-09-18']);
    expect(rows).toHaveLength(2);
    expect(rows[0].totalMiles).toBe(75000);
    expect(orch.getJobs().every((j) => j.status === 'done')).toBe(true);
  });

  it('キャプチャが来ないジョブはリトライ後 failed', async () => {
    const { hooks } = makeHooks(); // runSearch は acceptCapture を呼ばない
    const orch = new SweepOrchestrator(hooks, config);
    await orch.run();
    expect(orch.getJobs().every((j) => j.status === 'failed')).toBe(true);
    expect(orch.getJobs()[0].attempts).toBe(3); // 初回 + リトライ2
  });

  it('block() で blocked 状態になり実行が止まる', async () => {
    const { hooks } = makeHooks();
    let orch!: SweepOrchestrator;
    const runSearch = (job: SearchJob) => {
      orch.block('HTTP 403');
      // block 後はキャプチャを供給しない
      void job;
    };
    orch = new SweepOrchestrator({ ...hooks, runSearch }, config);
    await orch.run();
    expect(orch.getState()).toBe('blocked');
  });
});
