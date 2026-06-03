// ===========================================================================
// 共有型定義。chrome.* に依存しない純粋な型のみをここに置く。
// ===========================================================================

export type AwardType = 'domestic' | 'international';

export type OperatorType = 'ANA' | 'PARTNER'; // PARTNER = スターアライアンス提携運航便

export type Cabin = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS' | 'FIRST';

/** 0 = 日曜 ... 6 = 土曜 (JavaScript Date.getDay() 準拠) */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// --- 検索条件 -------------------------------------------------------------

export interface SweepConfig {
  type: AwardType;
  /** 出発空港コード (例: "HND") */
  depart: string;
  /** 目的地空港コード (例: "HNL") */
  dest: string;
  /** 検索対象期間の開始日 YYYY-MM-DD (この日の出発便から) */
  periodStart: string;
  /** 検索対象期間の終了日 YYYY-MM-DD (この日の出発便まで) */
  periodEnd: string;
  /** 出発曜日フィルタ。空集合は「全曜日」を意味する */
  weekdays: Weekday[];
  /** 帰国便オフセット: 出発の何日後に帰るか (0 = 当日, 7 = 1週間後) */
  returnOffsetDays: number;
  /** 希望キャビン */
  cabin: Cabin;
  /** スロットル設定 (ms) */
  throttle?: ThrottleConfig;
  /**
   * 取得方式。'legacy-intl' = 旧国際線エンジンのページ(DOM)を再検索フォームで
   * めくる方式 / 'json' = 新エンジンのJSON傍受方式 (将来)。未指定なら type から推定。
   */
  engine?: 'legacy-intl' | 'json';
}

export interface ThrottleConfig {
  /** ジョブ間の最小待機 (ms) */
  baseMs: number;
  /** ジョブ間に加算するランダム上限 (ms)。実待機 = base + random(0..spread) */
  spreadMs: number;
  /** N件ごとに長休止する間隔。0 で無効 */
  longPauseEvery: number;
  /** 長休止の長さ (ms) */
  longPauseMs: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  baseMs: 4000,
  spreadMs: 3000,
  longPauseEvery: 10,
  longPauseMs: 30000,
};

// --- 検索ジョブ -----------------------------------------------------------

export type JobStatus = 'pending' | 'running' | 'done' | 'empty' | 'failed';

export interface SearchJob {
  id: string;
  /** 往路出発日 YYYY-MM-DD */
  outboundDate: string;
  /** 復路出発日 YYYY-MM-DD */
  returnDate: string;
  status: JobStatus;
  /** 失敗時の理由 */
  failureReason?: string;
  attempts: number;
}

// --- 結果データモデル -----------------------------------------------------

export interface FlightSegment {
  /** 便名キャリア (例: "NH") */
  marketingCarrier: string;
  /** 運航キャリア (例: "NH" / "UA" / "LH") */
  operatingCarrier: string;
  flightNumber: string;
  depAirport: string;
  arrAirport: string;
  /** 出発時刻 ISO ローカル "YYYY-MM-DDTHH:mm" */
  depTime: string;
  /** 到着時刻 ISO ローカル "YYYY-MM-DDTHH:mm" */
  arrTime: string;
  cabin: Cabin;
}

export interface Itinerary {
  direction: 'OUT' | 'RET';
  date: string; // YYYY-MM-DD
  segments: FlightSegment[]; // >1 で乗り継ぎ
  operatorType: OperatorType;
  availableSeats?: number | null;
}

export interface FuelSurcharge {
  amount: number;
  currency: string; // 例: "JPY"
}

/** 予約可能な1つの往復組み合わせ = 結果テーブルの1行 */
export interface ResultRow {
  id: string;
  outbound: Itinerary;
  inbound: Itinerary;
  /** 往復の必要マイル合計 */
  totalMiles: number;
  /** 燃油サーチャージ。国内線や無料便は null */
  fuelSurcharge: FuelSurcharge | null;
  cabin: Cabin;
  type: AwardType;
  capturedAt: string; // ISO
}

// --- 傍受キャプチャ -------------------------------------------------------

export interface RawCapture {
  url: string;
  method: string;
  requestBody?: string;
  status: number;
  /** レスポンス本文 (テキスト) */
  body: string;
  capturedAt: string;
}

// --- メッセージ (Port) 型 -------------------------------------------------

/** MAIN(interceptor) → ISOLATED(content) への window.postMessage ペイロード */
export interface PageCaptureMessage {
  __ana_ext: true;
  kind: 'capture';
  capture: RawCapture;
}

/** content → service-worker */
export type ContentToSwMessage =
  | { type: 'CAPTURE'; capture: RawCapture }
  | { type: 'PAGE_READY'; url: string }
  | { type: 'CHALLENGE_DETECTED'; reason: string }
  // 旧国際線エンジン: 結果ページ読込完了。現在の日付ペアと解析済み行を報告
  | { type: 'LEGACY_PAGE_READY'; outboundDate: string; returnDate: string; rows: ResultRow[]; isResultPage: boolean };

/** service-worker → content */
export type SwToContentMessage =
  | { type: 'RUN_SEARCH'; job: SearchJob; config: SweepConfig }
  | { type: 'SET_DEV_CAPTURE'; enabled: boolean }
  // 旧国際線エンジン: 再検索フォームに日付を入れて検索実行 (ページ遷移が起きる)
  | { type: 'LEGACY_SUBMIT'; outboundDate: string; returnDate: string };

/** panel → service-worker */
export type PanelToSwMessage =
  | { type: 'START_SWEEP'; config: SweepConfig }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'CANCEL' }
  | { type: 'RETRY_FAILED' }
  | { type: 'GET_STATE' }
  | { type: 'SET_DEV_CAPTURE'; enabled: boolean }
  | { type: 'CLEAR_RESULTS' };

export type SweepRunState =
  | 'idle'
  | 'running'
  | 'paused'
  | 'done'
  | 'cancelled'
  | 'blocked';

export interface SweepProgress {
  state: SweepRunState;
  total: number;
  done: number;
  found: number;
  empty: number;
  failed: number;
  currentJob?: SearchJob;
  /** 推定残り時間 (ms) */
  etaMs?: number;
  message?: string;
}

/** service-worker → panel */
export type SwToPanelMessage =
  | { type: 'PROGRESS'; progress: SweepProgress }
  | { type: 'RESULT_ROWS'; rows: ResultRow[] }
  | { type: 'STATE_SNAPSHOT'; progress: SweepProgress; rows: ResultRow[]; devCapture: boolean }
  | { type: 'ERROR'; message: string };
