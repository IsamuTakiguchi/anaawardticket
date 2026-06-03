// ===========================================================================
// 旧国際線エンジン用スイープ制御。
// このエンジンは再検索のたびにページ全体がリロードされるため、tight loop では
// なく「イベント駆動の状態機械」で制御する:
//   submit(日付) → ページ遷移 → 新ページ読込 → onPageReady(日付, 行) → 次へ
// chrome.* に依存せず、タイマー/副作用は hooks 経由 (単体テスト可能)。
// ===========================================================================

import { buildJobMatrix } from '../core/date-matrix';
import type {
  ResultRow,
  SearchJob,
  SweepConfig,
  SweepProgress,
  SweepRunState,
} from '../core/types';
import { DEFAULT_THROTTLE } from '../core/types';

export interface LegacyHooks {
  /** content script へ「この目的地・日付で再検索」を指示 (ページ遷移が起きる) */
  submit(job: SearchJob): void;
  onRows(rows: ResultRow[]): void;
  onProgress(progress: SweepProgress): void;
  persist(jobs: SearchJob[], state: SweepRunState, cursor: number, config: SweepConfig): void;
  /** タイマー設定 (前のタイマーは自動クリア)。テストで差し替え可能 */
  setTimer(ms: number, fn: () => void): void;
  clearTimer(): void;
}

const JOB_TIMEOUT_MS = 30000; // 再検索後にページが来ないときのタイムアウト
const MAX_ATTEMPTS = 3;

export class LegacySweepController {
  private config: SweepConfig;
  private jobs: SearchJob[];
  private cursor = 0;
  private state: SweepRunState = 'idle';
  private found = 0;
  private empty = 0;
  private failed = 0;

  constructor(private hooks: LegacyHooks, config: SweepConfig, jobs?: SearchJob[], cursor = 0) {
    this.config = config;
    this.jobs = jobs ?? buildJobMatrix(config);
    this.cursor = cursor;
    this.recount();
  }

  getState(): SweepRunState {
    return this.state;
  }
  getJobs(): SearchJob[] {
    return this.jobs;
  }

  private get throttleWait(): number {
    const t = this.config.throttle ?? DEFAULT_THROTTLE;
    let wait = t.baseMs + Math.floor(Math.random() * (t.spreadMs + 1));
    if (t.longPauseEvery > 0 && this.cursor > 0 && this.cursor % t.longPauseEvery === 0) {
      wait += t.longPauseMs;
    }
    return wait;
  }

  /** スイープ開始: 最初のジョブを投入 */
  start(): void {
    if (this.state === 'running') return;
    this.state = 'running';
    this.emitProgress();
    this.submitCurrent();
  }

  resume(): void {
    if (this.state === 'paused' || this.state === 'blocked' || this.state === 'idle') {
      if (this.cursor < this.jobs.length) {
        this.state = 'running';
        this.emitProgress();
        this.submitCurrent();
      }
    }
  }

  pause(): void {
    if (this.state === 'running') {
      this.state = 'paused';
      this.hooks.clearTimer();
      this.persist();
      this.emitProgress('一時停止しました');
    }
  }

  cancel(): void {
    this.state = 'cancelled';
    this.hooks.clearTimer();
    this.persist();
    this.emitProgress('中止しました');
  }

  block(reason: string): void {
    if (this.state === 'running') {
      this.state = 'blocked';
      this.hooks.clearTimer();
      this.persist();
      this.emitProgress(`ANAから確認/再ログインを求められた可能性があります (${reason})。完了後Resumeしてください。`);
    }
  }

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

  /** 結果ページ読込完了の通知を受けて次へ進める */
  onPageReady(outboundDate: string, returnDate: string, dest: string, cabin: string, rows: ResultRow[], isResultPage: boolean): void {
    if (this.state !== 'running') return;
    if (!isResultPage) return; // 検索フォーム等。結果ページのみ扱う
    const job = this.jobs[this.cursor];
    if (!job) return;
    // 期待している目的地・日付ペアと一致するときだけ受理 (ユーザー操作や古いページを無視)
    if (outboundDate !== job.outboundDate || returnDate !== job.returnDate) return;
    // dest/cabin は読めない場合があるため、取得できたときのみ突き合わせる
    if (dest && job.dest && dest !== job.dest) return;
    if (cabin && job.cabin && cabin !== job.cabin) return;

    this.hooks.clearTimer();
    if (rows.length > 0) {
      job.status = 'done';
      this.found++;
      this.hooks.onRows(rows);
    } else {
      job.status = 'empty';
      this.empty++;
    }
    this.advance();
  }

  // --- 内部 -------------------------------------------------------------

  private submitCurrent(): void {
    const job = this.jobs[this.cursor];
    if (!job) {
      this.finish();
      return;
    }
    job.status = 'running';
    job.attempts++;
    this.persist();
    this.emitProgress();
    this.hooks.submit(job);
    this.hooks.setTimer(JOB_TIMEOUT_MS, () => this.onTimeout());
  }

  private onTimeout(): void {
    if (this.state !== 'running') return;
    const job = this.jobs[this.cursor];
    if (!job) return;
    if (job.attempts < MAX_ATTEMPTS) {
      this.submitCurrent(); // 再投入
    } else {
      job.status = 'failed';
      job.failureReason = 'タイムアウト/ページ未取得';
      this.failed++;
      this.advance();
    }
  }

  private advance(): void {
    this.cursor++;
    this.persist();
    this.emitProgress();
    if (this.cursor >= this.jobs.length) {
      this.finish();
      return;
    }
    this.hooks.setTimer(this.throttleWait, () => {
      if (this.state === 'running') this.submitCurrent();
    });
  }

  private finish(): void {
    if (this.state === 'running') {
      this.state = 'done';
      this.persist();
      this.emitProgress('完了しました');
    }
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
    const t = this.config.throttle ?? DEFAULT_THROTTLE;
    return remaining * (t.baseMs + t.spreadMs / 2 + 6000);
  }

  private emitProgress(message?: string): void {
    this.hooks.onProgress({
      state: this.state,
      total: this.jobs.length,
      done: this.doneCount(),
      found: this.found,
      empty: this.empty,
      failed: this.failed,
      currentJob: this.jobs[this.cursor],
      etaMs: this.state === 'running' ? this.estimateEta() : undefined,
      message,
    });
  }

  private persist(): void {
    this.hooks.persist(this.jobs, this.state, this.cursor, this.config);
  }
}
