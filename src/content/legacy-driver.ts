// ===========================================================================
// 旧国際線エンジン (aswbe-i .../award_search_roundtrip_result_owd.xhtml) の
// content script 側ドライバ。結果ページの検出・検索条件の読取・再検索フォームの
// 自動投入を行う。
//
// ⚠ JSF の自動採番ID・確認ダイアログ・Akamai bot 検知があるため、フォーム投入部は
//   実機での微調整が必要。セレクタが見つからない場合は false を返し、上位の
//   タイムアウト処理に委ねる。
// ===========================================================================

import { parseLegacyIntlResult } from '../core/legacy-intl-parser';
import type { AnaAirportList, Cabin, ResultRow } from '../core/types';

const CFF_CABIN: Record<string, Cabin> = {
  CFF1: 'ECONOMY', CFF4: 'PREMIUM_ECONOMY', CFF2: 'BUSINESS', CFF3: 'FIRST',
};
const CABIN_CFF: Record<Cabin, string> = {
  ECONOMY: 'CFF1', PREMIUM_ECONOMY: 'CFF4', BUSINESS: 'CFF2', FIRST: 'CFF3',
};

export function isLegacyResultPage(): boolean {
  return (
    location.hostname.endsWith('aswbe-i.ana.co.jp') &&
    /award_search_roundtrip_result/.test(location.pathname) &&
    document.querySelector('.selectItinerary') != null
  );
}

/** 空席なし（条件に合うものがありませんでした）ページか */
export function isNoResultsPage(): boolean {
  const t = document.body?.textContent ?? '';
  return /合うものがありませんでした|検索内容に合うもの/.test(t);
}

/** ANA旧国際線の award 関連ページか (結果/空席なし/再検索を含む) */
export function isLegacyAwardPage(): boolean {
  return (
    location.hostname.endsWith('aswbe-i.ana.co.jp') &&
    /award_search/.test(location.pathname)
  );
}

function ymd(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : yyyymmdd;
}

/** ページ埋め込みの Asw.SearchCriteriaOutput から検索条件を読む。
 *  無ければ再検索フォームの hidden フィールドから読む (空席なしページ対策)。 */
export function readSearchCriteria(): { outboundDate: string; returnDate: string; dest: string; cabin: Cabin } | null {
  const scripts = Array.from(document.querySelectorAll('script'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const m = /Asw\.SearchCriteriaOutput\s*=\s*(\{[\s\S]*?\});/.exec(scripts);
  if (m) {
    try {
      const sc = JSON.parse(m[1]) as {
        requestedSegmentList?: { arrival?: { airportCode?: string }; departureDateYyyyMMdd?: string }[];
        cffCodeInput?: string;
      };
      const o = ymd(sc.requestedSegmentList?.[0]?.departureDateYyyyMMdd ?? '');
      const r = ymd(sc.requestedSegmentList?.[1]?.departureDateYyyyMMdd ?? '');
      const dest = sc.requestedSegmentList?.[0]?.arrival?.airportCode ?? '';
      if (o && r) return { outboundDate: o, returnDate: r, dest, cabin: CFF_CABIN[sc.cffCodeInput ?? ''] ?? 'ECONOMY' };
    } catch { /* fall through */ }
  }
  // フォールバック: 再検索フォームの hidden フィールド (空席なしページでも存在する)
  const dep = (document.getElementById('awardDepartureDate:field') as HTMLInputElement | null)?.value ?? '';
  const ret = (document.getElementById('awardReturnDate:field') as HTMLInputElement | null)?.value ?? '';
  const cff = (document.getElementById('boardingClass') as HTMLSelectElement | null)?.value ?? '';
  const dest = (document.getElementById('arrivalAirportCode:field') as HTMLInputElement | null)?.value ?? '';
  if (/^\d{8}$/.test(dep) && /^\d{8}$/.test(ret)) {
    return { outboundDate: ymd(dep), returnDate: ymd(ret), dest, cabin: CFF_CABIN[cff] ?? 'ECONOMY' };
  }
  return null;
}

/** 現在の結果ページを解析して行・日付・目的地・クラスを返す */
export function parseCurrentPage(): { outboundDate: string; returnDate: string; dest: string; cabin: Cabin; rows: ResultRow[] } | null {
  const ctx = readSearchCriteria();
  if (!ctx || !ctx.outboundDate || !ctx.returnDate) return null;
  const rows = parseLegacyIntlResult(document, ctx);
  return { outboundDate: ctx.outboundDate, returnDate: ctx.returnDate, dest: ctx.dest, cabin: ctx.cabin, rows };
}

/**
 * ANAページ埋め込みの空港リスト (Asw.AirportList の new s.Region/new s.Airport) を
 * 抽出する。これによりドロップダウンを ANA と同じ選択肢にできる。
 */
export function extractAnaAirports(): AnaAirportList | null {
  const scripts = Array.from(document.querySelectorAll('script'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const regions: { code: string; name: string }[] = [];
  const reRegion = /new\s+s\.Region\('([^']*)','([^']*)'/g;
  let rm: RegExpExecArray | null;
  while ((rm = reRegion.exec(scripts)) !== null) regions.push({ name: rm[1], code: rm[2] });

  const airports: { code: string; name: string; region: string }[] = [];
  const reAir = /new\s+s\.Airport\('([^']*)','[^']*','([^']*)','([^']*)'/g;
  let am: RegExpExecArray | null;
  while ((am = reAir.exec(scripts)) !== null) {
    airports.push({ name: am[1], code: am[2], region: am[3] });
  }
  if (airports.length === 0) return null;
  return { regions, airports };
}

function setInput(id: string, value: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return false;
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * 再検索フォームに往路/復路日付(YYYY-MM-DD)を入れて検索を実行する。
 * ページ遷移(POST)が発生する。成功裡に投入できたら true。
 * 実機差異の切り分けのため各ステップを console に出力する。
 */
export function legacySubmit(
  outboundDate: string,
  returnDate: string,
  depart?: string,
  dest?: string,
  cabin?: Cabin,
): boolean {
  const TAG = '[ana-sweep:legacy]';
  const out = outboundDate.replace(/-/g, '');
  const ret = returnDate.replace(/-/g, '');
  // 投稿される hidden の日付フィールド (権威) を更新
  const okOut = setInput('awardDepartureDate:field', out);
  const okRet = setInput('awardReturnDate:field', ret);
  // 表示用テキストも更新 (バリデーション対策。失敗しても致命的でない)
  setInput('awardDepartureDate:field_pctext', out);
  setInput('awardReturnDate:field_pctext', ret);
  // 路線 (空港コード) も指定されていれば hidden フィールドを更新
  if (depart) {
    const ok = setInput('departureAirportCode:field', depart);
    console.info(`${TAG} 出発地投入 ${depart} (field=${ok})`);
  }
  if (dest) {
    const ok = setInput('arrivalAirportCode:field', dest);
    console.info(`${TAG} 目的地投入 ${dest} (field=${ok})`);
  }
  // キャビン (特典種別 CFF コード) も指定されていれば boardingClass を更新
  if (cabin) {
    const cff = CABIN_CFF[cabin];
    const ok = setInput('boardingClass', cff);
    console.info(`${TAG} クラス投入 ${cabin}/${cff} (field=${ok})`);
  }
  console.info(`${TAG} 日付投入 out=${out} ret=${ret} (depField=${okOut}, retField=${okRet})`);
  if (!okOut || !okRet) {
    console.warn(`${TAG} 日付の hidden フィールドが見つかりません`);
    return false;
  }

  // #displaySearchModal 内の「検索する」submit を探してクリック
  const modal = document.getElementById('displaySearchModal');
  const submits = Array.from(modal?.querySelectorAll<HTMLInputElement>('input[type="submit"]') ?? []);
  console.info(`${TAG} modal内のsubmit候補: ` + submits.map((b) => b.value).join(' | '));
  const searchBtn = submits.find((b) => /検索/.test(b.value));
  if (searchBtn) {
    console.info(`${TAG} 「${searchBtn.value}」をクリックします`);
    searchBtn.click();
    return true;
  }

  // フォールバック: JSF の再検索リンク (#toRoundTrip) を起動して reSearchForm を送信
  const anchor = document.getElementById('toRoundTrip') as HTMLAnchorElement | null;
  if (anchor) {
    console.info(`${TAG} 検索ボタンが見つからないため #toRoundTrip で送信します`);
    anchor.click();
    return true;
  }

  console.warn(`${TAG} 検索ボタン/再検索リンクが見つかりません`);
  return false;
}
