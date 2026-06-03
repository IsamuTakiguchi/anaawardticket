// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLegacyIntlResult } from '../src/core/legacy-intl-parser';

function loadDoc(name: string): Document {
  const html = readFileSync(join(process.cwd(), 'fixtures', name), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const ctx = { outboundDate: '2026-11-05', returnDate: '2026-11-08', cabin: 'ECONOMY' as const };

describe('parseLegacyIntlResult (旧国際線エンジン)', () => {
  const rows = parseLegacyIntlResult(loadDoc('legacy-intl-result.sample.html'), ctx);

  it('recommendation の数だけ結果行を生成', () => {
    expect(rows).toHaveLength(3);
  });

  it('必要マイルを recommendation から取得', () => {
    expect(rows.map((r) => r.totalMiles).sort()).toEqual([20000, 20000, 23000]);
  });

  it('UA運航(提携)とANA運航を判定', () => {
    // rec(0,0,0): 往路UA150(提携)・復路UA151(提携)
    const r0 = rows.find((r) => r.id === '0_0')!;
    expect(r0.outbound.operatorType).toBe('PARTNER');
    expect(r0.inbound.operatorType).toBe('PARTNER');
    // rec(4,1,0): 往路 NH412/NH869/UA184 (UA混在=提携)・復路 UA151(提携)
    const r1 = rows.find((r) => r.id === '1_0')!;
    expect(r1.outbound.operatorType).toBe('PARTNER'); // UA184を含む
    // rec(1,0,2): 復路 UA849+NH985 (UA混在=提携)
    const r2 = rows.find((r) => r.id === '0_2')!;
    expect(r2.inbound.operatorType).toBe('PARTNER');
  });

  it('税金・料金(表示の円)をサーチャージとして取得、0 は null', () => {
    expect(rows.find((r) => r.id === '0_0')!.fuelSurcharge).toBeNull();
    expect(rows.find((r) => r.id === '0_2')!.fuelSurcharge).toEqual({ amount: 5000, currency: 'JPY' });
  });

  it('運航航空会社名を取得 (ANA運航便アイコン/○○運航テキスト)', () => {
    const r = rows.find((r) => r.id === '1_0')!;
    // 往路 NH412(ANA) / NH869(ANA) / UA184(ユナイテッド航空)
    expect(r.outbound.segments.map((s) => s.carrierName)).toEqual(['ANA', 'ANA', 'ユナイテッド航空']);
    expect(rows.find((r) => r.id === '0_0')!.outbound.segments[0].carrierName).toBe('ユナイテッド航空');
  });

  it('空席数を recommendation から取得', () => {
    const r = rows.find((r) => r.id === '1_0')!;
    expect(r.outbound.availableSeats).toBe(3);
    expect(r.inbound.availableSeats).toBe(9);
  });

  it('便名・空港・時刻を DOM から取得', () => {
    const r = rows.find((r) => r.id === '0_0')!;
    const seg = r.outbound.segments[0];
    expect(seg.operatingCarrier).toBe('UA');
    expect(seg.flightNumber).toBe('150');
    expect(seg.depAirport).toBe('大阪(関西)');
    expect(seg.arrAirport).toBe('グアム');
    expect(seg.depTime).toBe('2026-11-05T11:05');
    expect(seg.arrTime).toBe('2026-11-05T15:45');
  });

  it('乗り継ぎ便 (3区間) を展開', () => {
    const r = rows.find((r) => r.id === '1_0')!;
    expect(r.outbound.segments).toHaveLength(3);
    expect(r.outbound.segments.map((s) => s.operatingCarrier)).toEqual(['NH', 'NH', 'UA']);
  });
});
