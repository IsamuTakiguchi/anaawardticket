// ===========================================================================
// スイープ・オーケストレーター。
// 検索ジョブ列を逐次 (並列禁止) に実行し、ジッタ付きスロットル・リトライ・
// pause/resume/cancel・challenge 時の自動停止・進捗通知を担う。
// chrome.* には依存せず、外部から注入された hooks 経由で副作用を行うため
// 単体テスト可能。
// ===========================================================================

import { buildJobMatrix } from '../core/date-matrix';
import { parseCapture } from '../core/parse-capture';
import type {
  RawCapture,
  ResultRow,
  SearchJob,
  SweepConfig,
  SweepProgress,
  SweepRunState,
  ThrottleConfig,
} from '../core/types';
import { DEFAULT_THROTTLE } from '../core/types';

export interface OrchestratorHooks {
  /** content script へ検索実行を指示 */
  runSearch(job: SearchJob, config: SweepConfig): void;
  /** 結果行を保存・パネルへ通知 */
  onRows(rows: ResultRow[]): void;
  /** 進捗をパネルへ通知 */
  onProgress(progress: SweepProgress): void;
  /** 状態を永続化 */
  persist(jobs: SearchJob[], state: SweepRunState, cursor: number, config: SweepConfig): void;
  /** sleep (テストで差し替え可能) */
  sleep(ms: number): Promise<void>;
}

/** 1 ジョブで最初のキャプチャ後に追加キャプチャを待つ時間 (ページング集約用) */
const SETTLE_MS = 1500;
/** 1 ジョブのキャプチャ待ちタイムアウト */
const JOB_TIMEOUT_MS = 25000;
const MAX_ATTEMPTS = 3; // 初回 + リトライ2回
const RETRY_BACKOFF_MS = [8000, 20000];

export class SweepOrchestrator {
  private config: SweepConfig;
  private jobs: SearchJob[] = [];
  private cursor = 0;
  private state: SweepRunState = 'idle';
  private found = 0;
  private empty = 0;
  private failed = 0;

  // 現ジョブのキャプチャ収集
  private collecting = false;
  private currentCaptures: RawCapture[] = [];
  private firstCaptureAt = 0;

  constructor(private hooks: OrchestratorHooks, config: SweepConfig, jobs?: SearchJob[]) {
    this.config = config;
    this.jobs = jobs ?? buildJobMatrix(config);
  }

  get throttle(): ThrottleConfig {
    return this.config.throttle ?? DEFAULT_THROTTLE;
  }

  getState(): SweepRunState {
    return this.state;
  }

  getJobs(): SearchJob[] {
    return this.jobs;
  }

  /** 空席照会キャプチャを受け取る (SW から呼ばれる) */
  acceptCapture(capture: RawCapture): void {
    if (!this.collecting) return;
    if (this.currentCaptures.length === 0) this.firstCaptureAt = Date.now();
    this.currentCaptures.push(capture);
  }

  /** challenge 検知時に SW から呼ばれる: スイープを停止 */
  block(reason: string): void {
    if (this.state === 'running') {
      this.state = 'blocked';
      this.persist();
      this.emitProgress(`ANA から認証/確認を要求された可能性があります (${reason})。再ログイン後に再開してください。`);
    }
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
      this.persist();
      this.emitProgress('一時停止しました');
    }
  }

  cancel(): void {
    this.state = 'cancelled';
    this.persist();
    this.emitProgress('中止しました');
  }

  /** 失敗ジョブを pending に戻して再実行可能にする */
  resetFailed(): void {
    for (const j of this.jobs) {
      if (j.status === 'failed') {
        j.status = 'pending';
        j.attempts = 0;
      }
    }
    this.failed = 0;
    this.cursor = 0;
  }

  /** メインループ。running 状態である限りジョブを逐次処理する */
  async run(): Promise<void> {
    if (this.state === 'running') return; // 二重起動防止
    this.state = 'running';
    this.recount();
    this.emitProgress();

    while (this.cursor < this.jobs.length) {
      if ((this.state as SweepRunState) !== 'running') break; // paused/cancelled/blocked

      const job = this.jobs[this.cursor];
      if (job.status === 'done' || job.status === 'empty' || job.status === 'failed') {
        this.cursor++;
        continue;
      }

      await this.processJob(job);
      this.cursor++;
      this.persist();
      this.emitProgress();

      if ((this.state as SweepRunState) !== 'running') break;
      if (this.cursor < this.jobs.length) await this.throttleWait();
    }

    if (this.state === 'running') {
      this.state = 'done';
      this.persist();
      this.emitProgress('完了しました');
    }
  }

  // --- 内部 ---------------------------------------------------------------

  private async processJob(job: SearchJob): Promise<void> {
    job.status = 'running';
    job.attempts++;
    this.emitProgress();

    // キャプチャ収集を開始し検索を指示
    this.collecting = true;
    this.currentCaptures = [];
    this.firstCaptureAt = 0;

    const captures = await this.collectForJob(job);
    this.collecting = false;

    if (captures.length === 0) {
      // タイムアウト or 応答なし → リトライ判定
      if (job.attempts < MAX_ATTEMPTS && (this.state as SweepRunState) === 'running') {
        await this.hooks.sleep(RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)]);
        if ((this.state as SweepRunState) === 'running') return this.processJob(job);
      }
      job.status = 'failed';
      job.failureReason = 'タイムアウト/応答なし';
      this.failed++;
      return;
    }

    // パース → 行生成
    const rows: ResultRow[] = [];
    for (const cap of captures) {
      rows.push(
        ...parseCapture(cap, {
          outboundDate: job.outboundDate,
          returnDate: job.returnDate,
          cabin: this.config.cabin,
          type: this.config.type,
        }),
      );
    }

    if (rows.length > 0) {
      job.status = 'done';
      this.found++;
      this.hooks.onRows(rows);
    } else {
      job.status = 'empty';
      this.empty++;
    }
  }

  /** 検索を指示し、最初のキャプチャ後 SETTLE_MS だけ追加を待つ。タイムアウトあり */
  private collectForJob(job: SearchJob): Promise<RawCapture[]> {
    this.hooks.runSearch(job, this.config);
    return new Promise<RawCapture[]>((resolve) => {
      const start = Date.now();
      const finish = () => resolve(this.currentCaptures.slice());

      const tick = async () => {
        if ((this.state as SweepRunState) !== 'running') return finish();
        const elapsed = Date.now() - start;
        const settled =
          this.currentCaptures.length > 0 && Date.now() - this.firstCaptureAt >= SETTLE_MS;
        if (settled || elapsed >= JOB_TIMEOUT_MS) return finish();
        await this.hooks.sleep(300);
        void tick();
      };
      void tick();
    });
  }

  private async throttleWait(): Promise<void> {
    const t = this.throttle;
    let wait = t.baseMs + Math.floor(Math.random() * (t.spreadMs + 1));
    const doneCount = this.cursor;
    if (t.longPauseEvery > 0 && doneCount > 0 && doneCount % t.longPauseEvery === 0) {
      wait += t.longPauseMs;
    }
    await this.hooks.sleep(wait);
  }

  private recount(): void {
    this.found = this.jobs.filter((j) => j.status === 'done').length;
    this.empty = this.jobs.filter((j) => j.status === 'empty').length;
    this.failed = this.jobs.filter((j) => j.status === 'failed').length;
  }

  private doneCount(): number {
    return this.jobs.filter(
      (j) => j.status === 'done' || j.status === 'empty' || j.status === 'failed',
    ).length;
  }

  private estimateEta(): number {
    const remaining = this.jobs.length - this.doneCount();
    const t = this.throttle;
    const avg = t.baseMs + t.spreadMs / 2 + 3000; // スロットル + 平均応答
    return remaining * avg;
  }

  private buildProgress(message?: string): SweepProgress {
    return {
      state: this.state,
      total: this.jobs.length,
      done: this.doneCount(),
      found: this.found,
      empty: this.empty,
      failed: this.failed,
      currentJob: this.jobs[this.cursor],
      etaMs: this.state === 'running' ? this.estimateEta() : undefined,
      message,
    };
  }

  private emitProgress(message?: string): void {
    this.hooks.onProgress(this.buildProgress(message));
  }

  private persist(): void {
    this.hooks.persist(this.jobs, this.state, this.cursor, this.config);
  }
}
