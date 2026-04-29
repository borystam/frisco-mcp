import { describe, it, expect } from 'vitest';
import {
  parseFriscoDate,
  normaliseOrderHistory,
  queryOrders,
  summariseSpend,
  formatOrderHistory,
  parseOrderDetailSection,
  type OrderHistory,
} from '../tools/orders.js';

const URL = 'https://www.frisco.pl/stn,user-orders';
const TODAY = new Date('2025-04-28');

const sampleRaw = [
  {
    orderId: 'FRI-1001',
    placedAt: '2025-04-15',
    deliveryAt: '2025-04-16',
    status: 'Dostarczone',
    totalText: '234,56 zł',
    detailHref: '/order/1001',
  },
  {
    orderId: 'FRI-1000',
    placedAt: '2025-03-28',
    deliveryAt: '2025-03-29',
    status: 'Anulowane',
    totalText: '50,00 zł',
    detailHref: '/order/1000',
  },
  {
    orderId: 'FRI-0999',
    placedAt: '12 marca 2025',
    deliveryAt: '13 marca 2025',
    status: 'Dostarczone',
    totalText: '128,90 zł',
    detailHref: null,
  },
  {
    orderId: 'FRI-NULL',
    placedAt: 'who knows',
    deliveryAt: '',
    status: 'Pending',
    totalText: '',
    detailHref: null,
  },
];

describe('parseFriscoDate', () => {
  it('passes ISO YYYY-MM-DD through', () => {
    expect(parseFriscoDate('2025-04-15')).toBe('2025-04-15');
  });
  it('parses Polish "12 marca 2025"', () => {
    expect(parseFriscoDate('12 marca 2025', TODAY)).toBe('2025-03-12');
  });
  it('parses dotted "12.03.2025"', () => {
    expect(parseFriscoDate('12.03.2025', TODAY)).toBe('2025-03-12');
  });
  it('parses dotted with 2-digit year', () => {
    expect(parseFriscoDate('05.04.25', TODAY)).toBe('2025-04-05');
  });
  it('defaults year to "today" when missing in Polish', () => {
    expect(parseFriscoDate('12 marca', TODAY)).toBe('2025-03-12');
  });
  it('returns null for unparsable input', () => {
    expect(parseFriscoDate('who knows')).toBeNull();
    expect(parseFriscoDate('')).toBeNull();
    expect(parseFriscoDate(null)).toBeNull();
  });
});

describe('normaliseOrderHistory', () => {
  it('parses prices and dates, joins detail URLs', () => {
    const h = normaliseOrderHistory(URL, sampleRaw, [], TODAY);
    expect(h.orders[0].totalValue).toBeCloseTo(234.56);
    expect(h.orders[0].placedAt).toBe('2025-04-15');
    expect(h.orders[0].detailUrl).toBe('https://www.frisco.pl/order/1001');
    expect(h.orders[2].placedAt).toBe('2025-03-12');
    expect(h.orders[3].placedAt).toBeNull();
    expect(h.orders[3].totalValue).toBeNull();
  });
});

describe('queryOrders', () => {
  const h: OrderHistory = normaliseOrderHistory(URL, sampleRaw, [], TODAY);

  it('filters by date range', () => {
    const r = queryOrders(h, { fromDate: '2025-04-01' });
    expect(r.map(o => o.orderId)).toEqual(['FRI-1001']);
  });
  it('filters by status (case-insensitive substring)', () => {
    const r = queryOrders(h, { status: 'dostarczone' });
    expect(r.map(o => o.orderId)).toEqual(['FRI-1001', 'FRI-0999']);
  });
  it('filters by minTotalPln', () => {
    const r = queryOrders(h, { minTotalPln: 100 });
    expect(r.map(o => o.orderId)).toEqual(['FRI-1001', 'FRI-0999']);
  });
  it('combines filters', () => {
    const r = queryOrders(h, {
      fromDate: '2025-03-01',
      toDate: '2025-03-31',
      status: 'dostarczone',
    });
    expect(r.map(o => o.orderId)).toEqual(['FRI-0999']);
  });
  it('honours limit', () => {
    const r = queryOrders(h, { limit: 1 });
    expect(r.length).toBe(1);
  });
});

describe('summariseSpend', () => {
  it('sums and averages numeric totals only', () => {
    const h = normaliseOrderHistory(URL, sampleRaw, [], TODAY);
    const s = summariseSpend(h.orders);
    expect(s.totalCount).toBe(4);
    expect(s.totalPln).toBeCloseTo(234.56 + 50 + 128.9, 2);
    expect(s.averagePln).toBeCloseTo((234.56 + 50 + 128.9) / 3, 2);
  });

  it('handles all-null totals safely', () => {
    const h = normaliseOrderHistory(
      URL,
      [{
        orderId: 'X',
        placedAt: '',
        deliveryAt: '',
        status: '',
        totalText: '',
        detailHref: null,
      }],
      [],
      TODAY,
    );
    const s = summariseSpend(h.orders);
    expect(s.totalPln).toBe(0);
    expect(s.averagePln).toBeNull();
  });
});

describe('formatOrderHistory', () => {
  it('renders order lines and a sum footer', () => {
    const h = normaliseOrderHistory(URL, sampleRaw, [], TODAY);
    const out = formatOrderHistory(h);
    expect(out).toContain('FRI-1001');
    expect(out).toContain('Σ');
    expect(out).toContain('zł');
  });
  it('shows empty placeholder when filters exclude everything', () => {
    const h = normaliseOrderHistory(URL, sampleRaw, [], TODAY);
    const out = formatOrderHistory(h, { fromDate: '2030-01-01' });
    expect(out).toContain('No orders matched');
  });
  it('links detail URLs when available', () => {
    const h = normaliseOrderHistory(URL, sampleRaw, [], TODAY);
    const out = formatOrderHistory(h);
    expect(out).toContain('https://www.frisco.pl/order/1001');
  });
});

describe('parseOrderDetailSection', () => {
  // Captured 2026-04-29 from live frisco order detail page (BRAND-X
  // placeholders so no real product text leaks into the test fixture).
  const TWO_ITEMS_PLAIN = [
    'BRAND-A',
    'Test product alpha',
    '500 g',
    '12,78 zł/kg',
    'Cena',
    '6,39 zł',
    '1',
    '0,00 zł',
    'Usuń',
    'Przydatny do 26-11-2028',
    'BRAND-B',
    'Test product beta',
    '340 g',
    '20,56 zł/kg',
    'Cena',
    '6,99 zł',
    '1',
    '0,00 zł',
    'Usuń',
    'Przydatny do 31-08-2028',
  ].join('\n');

  it('extracts brand, name, size, quantity from plain Cena rows', () => {
    const items = parseOrderDetailSection('Spiżarnia', TWO_ITEMS_PLAIN);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      category: 'Spiżarnia',
      brand: 'BRAND-A',
      name: 'Test product alpha',
      size: '500 g',
      quantity: 1,
      priceText: '6,39 zł',
      promo: false,
      unavailable: false,
    });
    expect(items[1]).toMatchObject({
      brand: 'BRAND-B',
      name: 'Test product beta',
      size: '340 g',
      quantity: 1,
    });
  });

  it('flags promo lines and quantity > 1', () => {
    const promoChunk = [
      'Promocja',
      'BRAND-C',
      'Test product gamma',
      '140 g',
      '52,07 zł/kg',
      'Cena promocyjna',
      '7,29 zł',
      '7,39 zł',
      'najniższa cena z 30 dni przed obniżką',
      '4',
      '0,00 zł',
      'Usuń',
      'Przydatny do 14-05-2026',
    ].join('\n');
    const items = parseOrderDetailSection('Mięso i wędliny', promoChunk);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      brand: 'BRAND-C',
      promo: true,
      quantity: 4,
      priceText: '7,29 zł',
    });
  });

  it('marks chwilowo niedostępny rows as unavailable with null quantity', () => {
    const unavailChunk = [
      'BRAND-D',
      'Test product delta',
      '1 l',
      '11,69 zł/l',
      'Cena',
      '11,69 zł',
      'Produkt chwilowo niedostępny',
      '0,00 zł',
      'Usuń',
    ].join('\n');
    const items = parseOrderDetailSection('Napoje', unavailChunk);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      unavailable: true,
      quantity: null,
      priceText: '11,69 zł',
    });
  });

  it('returns an empty list for empty input', () => {
    expect(parseOrderDetailSection('Inne', '')).toEqual([]);
  });
});
