import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adaptInternational } from '../src/core/adapter-international';
import { adaptDomestic } from '../src/core/adapter-domestic';
import type { RawAvailabilityResponse } from '../src/core/adapter';

function fixture(name: string): RawAvailabilityResponse {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('adapter-international', () => {
  const ctx = { outboundDate: '2026-09-10', returnDate: '2026-09-17', cabin: 'BUSINESS' as const };

  it('国際線: 往路2案 × 復路1案 = 2行', () => {
    const rows = adaptInternational(fixture('international-availability.sample.json'), ctx);
    expect(rows).toHaveLength(2);
  });

  it('zone pricing の必要マイルを採用', () => {
    const rows = adaptInternational(fixture('international-availability.sample.json'), ctx);
    expect(rows[0].totalMiles).toBe(75000);
  });

  it('ANA運航とUA運航(提携)を判定', () => {
    const rows = adaptInternational(fixture('international-availability.sample.json'), ctx);
    const ana = rows.find((r) => r.outbound.segments.length === 1)!;
    const partner = rows.find((r) => r.outbound.segments.length === 2)!;
    expect(ana.outbound.operatorType).toBe('ANA');
    expect(partner.outbound.operatorType).toBe('PARTNER');
  });

  it('時刻と空港が正規化される', () => {
    const rows = adaptInternational(fixture('international-availability.sample.json'), ctx);
    const seg = rows[0].outbound.segments[0];
    expect(seg.depTime).toBe('2026-09-10T21:25');
    expect(seg.depAirport).toBe('HND');
    expect(seg.arrAirport).toBe('HNL');
  });
});

describe('adapter-domestic', () => {
  const ctx = { outboundDate: '2026-07-18', returnDate: '2026-07-21', cabin: 'ECONOMY' as const };

  it('国内線は燃油サーチャージが必ず null', () => {
    const rows = adaptDomestic(fixture('domestic-availability.sample.json'), ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].fuelSurcharge).toBeNull();
  });

  it('option ごとの必要マイルを合算 (往復 7500+7500)', () => {
    const rows = adaptDomestic(fixture('domestic-availability.sample.json'), ctx);
    expect(rows[0].totalMiles).toBe(15000);
  });
});

describe('adapter フェイルソフト', () => {
  it('空レスポンスでもクラッシュしない', () => {
    expect(adaptInternational({}, { outboundDate: '2026-09-10', returnDate: '2026-09-17', cabin: 'BUSINESS' })).toEqual([]);
  });

  it('別名フィールド (itineraries/flights/departureAirport/mileage 等) でも解釈する', () => {
    const raw = {
      // outbound/inbound の別名は使わず、options の別名 itineraries / segments の別名 flights を使用
      outbound: {
        flightDate: '2026-09-10',
        itineraries: [
          {
            isAvailable: true,
            availableSeats: 3,
            mileage: 80000,
            flights: [
              {
                marketingAirline: 'NH',
                operatingAirline: 'LH',
                flightNo: '717',
                departureAirport: 'HND',
                arrivalAirport: 'MUC',
                scheduledDepartureTime: '2026-09-10T11:55:00',
                scheduledArrivalTime: '2026-09-10T16:40:00',
                cabinClass: 'BUSINESS',
              },
            ],
          },
        ],
      },
      inbound: {
        flightDate: '2026-09-17',
        itineraries: [
          {
            isAvailable: true,
            availableSeats: 2,
            flights: [
              { marketingAirline: 'NH', operatingAirline: 'NH', flightNo: '6', departureAirport: 'MUC', arrivalAirport: 'HND', scheduledDepartureTime: '1320', scheduledArrivalTime: '0855', cabinClass: 'BUSINESS' },
            ],
          },
        ],
      },
    };
    const rows = adaptInternational(raw as any, { outboundDate: '2026-09-10', returnDate: '2026-09-17', cabin: 'BUSINESS' });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalMiles).toBe(80000);
    expect(rows[0].outbound.operatorType).toBe('PARTNER'); // LH 運航
    expect(rows[0].outbound.segments[0].depTime).toBe('2026-09-10T11:55');
    expect(rows[0].inbound.operatorType).toBe('ANA');
  });

  it('運航会社フィールドが無くても便名先頭2文字で ANA/提携を判定', () => {
    const raw = {
      pricing: { requiredMiles: 90000 },
      outbound: {
        date: '2026-09-10',
        options: [
          { available: true, segments: [{ flightNumber: 'UA838', from: 'NRT', to: 'ORD', departureTime: '1640', arrivalTime: '1530' }] },
        ],
      },
      inbound: {
        date: '2026-09-17',
        options: [
          { available: true, segments: [{ flightNumber: 'NH9', from: 'ORD', to: 'NRT', departureTime: '1030', arrivalTime: '1420' }] },
        ],
      },
    };
    const rows = adaptInternational(raw as any, { outboundDate: '2026-09-10', returnDate: '2026-09-17', cabin: 'BUSINESS' });
    expect(rows[0].outbound.operatorType).toBe('PARTNER'); // UA
    expect(rows[0].outbound.segments[0].operatingCarrier).toBe('UA');
    expect(rows[0].inbound.operatorType).toBe('ANA'); // NH
  });

  it('available=false の option は除外', () => {
    const raw: RawAvailabilityResponse = {
      outbound: { date: '2026-09-10', options: [{ available: false, segments: [{ operatingCarrier: 'NH' }] }] },
      inbound: { date: '2026-09-17', options: [{ available: true, segments: [{ operatingCarrier: 'NH' }] }] },
    };
    expect(adaptInternational(raw, { outboundDate: '2026-09-10', returnDate: '2026-09-17', cabin: 'BUSINESS' })).toEqual([]);
  });
});
