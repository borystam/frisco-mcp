import { describe, it, expect } from 'vitest';
import {
  parseFriscoDate,
  normaliseOrderHistory,
  queryOrders,
  summariseSpend,
  formatOrderHistory,
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
