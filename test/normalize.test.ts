import { describe, it, expect } from 'vitest';
import {
  combineDateTime,
  normalizeCabin,
  normalizeSurcharge,
  operatorTypeOf,
  parseNumberLoose,
} from '../src/core/normalize';

describe('normalize', () => {
  it('parseNumberLoose', () => {
    expect(parseNumberLoose('75,000')).toBe(75000);
    expect(parseNumberLoose('¥12,345')).toBe(12345);
    expect(parseNumberLoose('7500マイル')).toBe(7500);
    expect(parseNumberLoose(42)).toBe(42);
    expect(parseNumberLoose('')).toBeNull();
    expect(parseNumberLoose(null)).toBeNull();
    expect(parseNumberLoose('abc')).toBeNull();
  });

  it('operatorTypeOf: NH のみは ANA, 他社混在は PARTNER', () => {
    expect(operatorTypeOf(['NH', 'NH'])).toBe('ANA');
    expect(operatorTypeOf(['NH', 'UA'])).toBe('PARTNER');
    expect(operatorTypeOf(['LH'])).toBe('PARTNER');
    expect(operatorTypeOf(['nh'])).toBe('ANA');
  });

  it('normalizeCabin', () => {
    expect(normalizeCabin('BUSINESS')).toBe('BUSINESS');
    expect(normalizeCabin('J')).toBe('BUSINESS');
    expect(normalizeCabin('ファースト')).toBe('FIRST');
    expect(normalizeCabin('プレミアムエコノミー')).toBe('PREMIUM_ECONOMY');
    expect(normalizeCabin('unknown')).toBe('ECONOMY');
    // ANA 特典運賃区分コード (FS/CS/WS/YS)
    expect(normalizeCabin('FS')).toBe('FIRST');
    expect(normalizeCabin('CS')).toBe('BUSINESS');
    expect(normalizeCabin('WS')).toBe('PREMIUM_ECONOMY');
    expect(normalizeCabin('YS')).toBe('ECONOMY');
  });

  it('normalizeSurcharge: 0 や不明は null', () => {
    expect(normalizeSurcharge(0)).toBeNull();
    expect(normalizeSurcharge(null)).toBeNull();
    expect(normalizeSurcharge('29,800', 'JPY')).toEqual({ amount: 29800, currency: 'JPY' });
  });

  it('combineDateTime', () => {
    expect(combineDateTime('2026-09-10', '2125')).toBe('2026-09-10T21:25');
    expect(combineDateTime('2026-09-10', '09:30')).toBe('2026-09-10T09:30');
    expect(combineDateTime('2026-09-10', '')).toBe('2026-09-10T00:00');
    // 完全な ISO 日時はその日付を優先
    expect(combineDateTime('2026-01-01', '2026-09-11T08:05:00')).toBe('2026-09-11T08:05');
    expect(combineDateTime('2026-01-01', '2026-09-11 08:05')).toBe('2026-09-11T08:05');
    // H:MM / HMM
    expect(combineDateTime('2026-09-10', '930')).toBe('2026-09-10T09:30');
  });
});
