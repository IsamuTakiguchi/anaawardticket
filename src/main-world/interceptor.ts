// ===========================================================================
// MAIN ワールド傍受スクリプト (run_at: document_start)。
// ANA ページ自身の JS より先に window.fetch / XMLHttpRequest をパッチし、
// 空席照会レスポンスを捕捉して content script へ window.postMessage で渡す。
//
// 制約: MAIN ワールドからは chrome.* を呼べないため、橋渡しは postMessage のみ。
// 防御的実装: 本文はクローンして消費せず、例外は決してページ側へ投げない。
// dev capture モードは content script から CustomEvent で受け取る。
// ===========================================================================

import { isAnaHost, isAvailabilityCall, isNoise } from '../core/endpoints';
import type { PageCaptureMessage, RawCapture } from '../core/types';

(() => {
  const TAG = '[ana-sweep:mw]';
  let devCapture = false;

  // content script からの dev capture トグル
  window.addEventListener('__ana_ext_dev_capture', (e: Event) => {
    devCapture = Boolean((e as CustomEvent).detail);
  });

  function shouldForward(url: string): boolean {
    if (!isAnaHost(url) || isNoise(url)) return false;
    return devCapture || isAvailabilityCall(url);
  }

  function forward(capture: RawCapture): void {
    try {
      const msg: PageCaptureMessage = { __ana_ext: true, kind: 'capture', capture };
      window.postMessage(msg, location.origin);
    } catch {
      /* noop: ページ側を壊さない */
    }
  }

  // --- fetch パッチ -------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const res = await origFetch.call(this, input as RequestInfo, init);
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (shouldForward(url)) {
        const clone = res.clone();
        clone
          .text()
          .then((body) =>
            forward({
              url,
              method: (init?.method ?? 'GET').toUpperCase(),
              requestBody: typeof init?.body === 'string' ? init.body : undefined,
              status: res.status,
              body,
              capturedAt: new Date().toISOString(),
            }),
          )
          .catch(() => void 0);
      }
    } catch {
      /* noop */
    }
    return res;
  };

  // --- XMLHttpRequest パッチ ---------------------------------------------
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;

  interface TaggedXhr extends XMLHttpRequest {
    __ana_url?: string;
    __ana_method?: string;
    __ana_reqBody?: string;
  }

  XHR.open = function (
    this: TaggedXhr,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__ana_url = typeof url === 'string' ? url : url.href;
    this.__ana_method = method.toUpperCase();
    // @ts-expect-error 可変長を元実装へ委譲
    return origOpen.call(this, method, url, ...rest);
  };

  XHR.send = function (this: TaggedXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    if (typeof body === 'string') this.__ana_reqBody = body;
    this.addEventListener('loadend', () => {
      try {
        const url = this.__ana_url ?? '';
        if (!shouldForward(url)) return;
        // responseText はテキスト系のみ。バイナリ等は空になるが許容。
        const text = this.responseType === '' || this.responseType === 'text'
          ? this.responseText
          : '';
        forward({
          url,
          method: this.__ana_method ?? 'GET',
          requestBody: this.__ana_reqBody,
          status: this.status,
          body: text,
          capturedAt: new Date().toISOString(),
        });
      } catch {
        /* noop */
      }
    });
    return origSend.call(this, body ?? null);
  };

  console.debug(TAG, 'interceptor installed');
})();
