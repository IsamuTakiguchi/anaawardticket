// ===========================================================================
// ページ自動操作ドライバ (ISOLATED ワールド)。
// ANA 検索フォームに条件を入力し検索を実行する。
//
// ⚠ ANA の DOM 構造 (セレクタ) は実サイトで確認が必要なため、ここでは
//   「セレクタ設定 + 汎用入力ヘルパー」の枠組みを用意する。Phase 2 で実セレクタを
//   SELECTORS に投入する。フォーム自動化が困難な場合は、ユーザーが手動で検索し
//   傍受だけ行う「手動モード」にフォールバックできるよう false を返す。
// ===========================================================================

import type { SearchJob, SweepConfig } from '../core/types';

interface FormSelectors {
  depart: string;
  dest: string;
  outboundDate: string;
  returnDate: string;
  submit: string;
}

// TODO(Phase2): 実サイトの DOM を dev capture / 手動調査で確認し投入する
const SELECTORS: Partial<Record<'domestic' | 'international', FormSelectors>> = {
  // international: { depart: '#dep', dest: '#arr', outboundDate: '#out', returnDate: '#ret', submit: 'button[type=submit]' },
};

function setNativeValue(el: HTMLElement, value: string): void {
  const input = el as HTMLInputElement;
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * 検索を実行する。フォーム自動操作に成功したら true、
 * セレクタ未設定などで自動化できなければ false (= 手動モード) を返す。
 */
export async function runSearch(job: SearchJob, config: SweepConfig): Promise<boolean> {
  const sel = SELECTORS[config.type];
  if (!sel) {
    console.info('[ana-sweep] フォームセレクタ未設定: 手動検索モードで傍受のみ行います');
    return false;
  }
  const depEl = document.querySelector<HTMLElement>(sel.depart);
  const destEl = document.querySelector<HTMLElement>(sel.dest);
  const outEl = document.querySelector<HTMLElement>(sel.outboundDate);
  const retEl = document.querySelector<HTMLElement>(sel.returnDate);
  const submitEl = document.querySelector<HTMLElement>(sel.submit);
  if (!depEl || !destEl || !outEl || !retEl || !submitEl) {
    console.warn('[ana-sweep] フォーム要素が見つかりません');
    return false;
  }
  setNativeValue(depEl, config.depart);
  setNativeValue(destEl, config.dest);
  setNativeValue(outEl, job.outboundDate);
  setNativeValue(retEl, job.returnDate);
  await new Promise((r) => setTimeout(r, 300));
  submitEl.click();
  return true;
}
