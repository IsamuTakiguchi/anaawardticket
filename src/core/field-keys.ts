// ===========================================================================
// ANA 内部 API のフィールド名は非公開で表記ゆれがありうるため、想定される
// キー候補を一元管理する。Dev capture で実フィールド名が判明したら、ここの
// 配列「先頭」に実際のキーを追記するだけで全アダプタが追従する。
// ===========================================================================

export const KEYS = {
  // コンテナ
  outbound: ['outbound', 'outward', 'onward', 'departureFlights', 'outboundFlights'],
  inbound: ['inbound', 'return', 'homeward', 'returnFlights', 'inboundFlights'],
  options: ['options', 'itineraries', 'itineraryList', 'flights', 'availabilityList', 'recommendations', 'segments'],
  segments: ['segments', 'flights', 'legs', 'flightSegments', 'flightList'],
  pricing: ['pricing', 'price', 'fare', 'award', 'priceInfo', 'fareInfo'],
  date: ['date', 'flightDate', 'departureDate', 'travelDate', 'boardDate'],

  // セグメント
  marketingCarrier: ['marketingCarrier', 'marketingAirline', 'marketingCarrierCode', 'marketingAirlineCode', 'airlineCode', 'carrier', 'carrierCode'],
  operatingCarrier: ['operatingCarrier', 'operatingAirline', 'operatingCarrierCode', 'operatingAirlineCode', 'opCarrier'],
  flightNumber: ['flightNumber', 'flightNo', 'flightNumberText', 'number', 'flightNum'],
  from: ['from', 'departureAirport', 'origin', 'depAirport', 'boardPoint', 'originAirportCode', 'departureAirportCode', 'fromAirport'],
  to: ['to', 'arrivalAirport', 'destination', 'arrAirport', 'offPoint', 'destinationAirportCode', 'arrivalAirportCode', 'toAirport'],
  departureTime: ['departureTime', 'depTime', 'departure', 'scheduledDepartureTime', 'departureDateTime', 'std', 'depDateTime'],
  arrivalTime: ['arrivalTime', 'arrTime', 'arrival', 'scheduledArrivalTime', 'arrivalDateTime', 'sta', 'arrDateTime'],
  cabin: ['cabin', 'cabinClass', 'classOfService', 'bookingClass', 'compartment', 'cabinCode'],

  // 空席・価格
  available: ['available', 'isAvailable', 'availableFlag', 'bookable'],
  seats: ['seats', 'availableSeats', 'seatCount', 'numberOfSeats', 'availabilityCount', 'availableSeatCount'],
  requiredMiles: ['requiredMiles', 'miles', 'mileage', 'requiredMileage', 'awardMiles', 'totalMiles', 'requiredMile'],
  fuelSurcharge: ['fuelSurcharge', 'surcharge', 'yqSurcharge', 'fuelSurchargeAmount', 'taxesAndFees', 'taxSurcharge'],
  amount: ['amount', 'value', 'total', 'price', 'totalAmount'],
  currency: ['currency', 'currencyCode', 'ccy'],
} as const;

export type AnyRec = Record<string, unknown>;

/** keys 候補のうち最初に値が存在するものを返す */
export function pick(obj: AnyRec | undefined | null, keys: readonly string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (k in obj && (obj as AnyRec)[k] != null) return (obj as AnyRec)[k];
  }
  return undefined;
}

/** 値を配列として取得 (非配列は空配列) */
export function pickArray(obj: AnyRec | undefined | null, keys: readonly string[]): AnyRec[] {
  const v = pick(obj, keys);
  return Array.isArray(v) ? (v as AnyRec[]) : [];
}

/** 値をレコードとして取得 */
export function pickRecord(obj: AnyRec | undefined | null, keys: readonly string[]): AnyRec | undefined {
  const v = pick(obj, keys);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRec) : undefined;
}
