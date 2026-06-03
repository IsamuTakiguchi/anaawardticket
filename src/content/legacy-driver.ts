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
import type { Cabin, ResultRow } from '../core/types';

const CFF_CABIN: Record<string, Cabin> = {
  CFF1: 'ECONOMY', CFF4: 'PREMIUM_ECONOMY', CFF2: 'BUSINESS', CFF3: 'FIRST',
};

export function isLegacyResultPage(): boolean {
  return (
    location.hostname.endsWith('aswbe-i.ana.co.jp') &&
    /award_search_roundtrip_result/.test(location.pathname) &&
    document.querySelector('.selectItinerary') != null
  );
}

function ymd(yyyymmdd: string): string {
  return /^\d{8}$/.test(yyyymmdd)
    ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
    : yyyymmdd;
}

/** ページ埋め込みの Asw.SearchCriteriaOutput から検索条件を読む */
export function readSearchCriteria(): { outboundDate: string; returnDate: string; cabin: Cabin } | null {
  const scripts = Array.from(document.querySelectorAll('script'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const m = /Asw\.SearchCriteriaOutput\s*=\s*(\{[\s\S]*?\});/.exec(scripts);
  if (!m) return null;
  try {
    const sc = JSON.parse(m[1]) as {
      requestedSegmentList?: { departureDateYyyyMMdd?: string }[];
      cffCodeInput?: string;
    };
    return {
      outboundDate: ymd(sc.requestedSegmentList?.[0]?.departureDateYyyyMMdd ?? ''),
      returnDate: ymd(sc.requestedSegmentList?.[1]?.departureDateYyyyMMdd ?? ''),
      cabin: CFF_CABIN[sc.cffCodeInput ?? ''] ?? 'ECONOMY',
    };
  } catch {
    return null;
  }
}

/** 現在の結果ページを解析して行と日付を返す */
export function parseCurrentPage(): { outboundDate: string; returnDate: string; rows: ResultRow[] } | null {
  const ctx = readSearchCriteria();
  if (!ctx || !ctx.outboundDate || !ctx.returnDate) return null;
  const rows = parseLegacyIntlResult(document, ctx);
  return { outboundDate: ctx.outboundDate, returnDate: ctx.returnDate, rows };
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
export function legacySubmit(outboundDate: string, returnDate: string): boolean {
  const TAG = '[ana-sweep:legacy]';
  const out = outboundDate.replace(/-/g, '');
  const ret = returnDate.replace(/-/g, '');
  // 投稿される hidden の日付フィールド (権威) を更新
  const okOut = setInput('awardDepartureDate:field', out);
  const okRet = setInput('awardReturnDate:field', ret);
  // 表示用テキストも更新 (バリデーション対策。失敗しても致命的でない)
  setInput('awardDepartureDate:field_pctext', out);
  setInput('awardReturnDate:field_pctext', ret);
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
