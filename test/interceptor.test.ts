// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest';

const AVAIL_URL = 'https://aswbe.ana.co.jp/webapps/availability';
const NOISE_URL = 'https://aswbe.ana.co.jp/static/app.js';

beforeAll(async () => {
  // interceptor は import 時に window.fetch をパッチするため、先にスタブを設定
  window.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).href ?? '';
    const body = url.includes('availability')
      ? JSON.stringify({ awardType: 'international', outbound: { options: [] } })
      : 'console.log(1)';
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  await import('../src/main-world/interceptor');
});

function nextCapture(timeoutMs = 500): Promise<any | null> {
  return new Promise((resolve) => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.__ana_ext && e.data.kind === 'capture') {
        window.removeEventListener('message', onMsg);
        resolve(e.data.capture);
      }
    };
    window.addEventListener('message', onMsg);
    setTimeout(() => {
      window.removeEventListener('message', onMsg);
      resolve(null);
    }, timeoutMs);
  });
}

describe('interceptor (fetch パッチ)', () => {
  it('空席照会 URL のレスポンスを postMessage で転送する', async () => {
    const captured = nextCapture();
    await window.fetch(AVAIL_URL);
    const cap = await captured;
    expect(cap).not.toBeNull();
    expect(cap.url).toBe(AVAIL_URL);
    expect(cap.status).toBe(200);
    expect(JSON.parse(cap.body).awardType).toBe('international');
  });

  it('静的アセット (ノイズ) は転送しない', async () => {
    const captured = nextCapture(300);
    await window.fetch(NOISE_URL);
    expect(await captured).toBeNull();
  });
});
