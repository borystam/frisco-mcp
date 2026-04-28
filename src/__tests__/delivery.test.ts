import { describe, it, expect } from 'vitest';
import {
  normaliseDeliveryGrid,
  querySlots,
  findCheapestSlot,
  findEarliestSlot,
  flattenSlots,
  formatGrid,
  type RawDay,
  type DeliveryGrid,
} from '../tools/delivery.js';

const URL = 'https://www.frisco.pl/stn,checkout-delivery';

const sampleRaw: RawDay[] = [
  {
    date: '2025-04-29',
    dayLabel: 'Wt',
    slots: [
      { time: '07:00 – 09:00', price: '0,00 zł', status: 'available', tag: 'EKO' },
      { time: '09:00 – 11:00', price: '9,99 zł', status: 'available' },
      { time: '12:00 – 14:00', price: '14,99 zł', status: 'unavailable' },
      { time: '18:00 – 20:00', price: '19,99 zł', status: 'available' },
    ],
  },
  {
    date: '2025-04-30',
    dayLabel: 'Śr',
    slots: [
      { time: '08:00 – 10:00', price: '4,99 zł', status: 'available' },
      { time: '14:00 – 16:00', price: '7,99 zł', status: 'available' },
      { time: '20:00 – 22:00', price: '24,99 zł', status: 'available' },
    ],
  },
];

describe('normaliseDeliveryGrid', () => {
  it('parses prices into numeric values', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, []);
    expect(grid.days[0].slots[0].priceValue).toBe(0);
    expect(grid.days[0].slots[1].priceValue).toBeCloseTo(9.99);
  });

  it('lower-cases tags', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, []);
    expect(grid.days[0].slots[0].tag).toBe('eko');
  });

  it('trims and de-noises notes', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, [
      '  Fuel surcharge applies   ',
      '',
      'Płatność kartą  online',
    ]);
    expect(grid.notes).toEqual(['Fuel surcharge applies', 'Płatność kartą online']);
  });

  it('preserves day order from input', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, []);
    expect(grid.days.map(d => d.date)).toEqual(['2025-04-29', '2025-04-30']);
  });
});

describe('querySlots', () => {
  const grid: DeliveryGrid = normaliseDeliveryGrid(URL, sampleRaw, []);

  it('filters available-only by default', () => {
    const pairs = querySlots(grid, {});
    expect(pairs.every(p => p.slot.status === 'available')).toBe(true);
  });

  it('filters by max price', () => {
    const pairs = querySlots(grid, { maxPricePln: 8 });
    expect(pairs.length).toBe(3); // free + 4.99 + 7.99
    expect(pairs.every(p => (p.slot.priceValue ?? 99) <= 8)).toBe(true);
  });

  it('filters by morning time-of-day', () => {
    const pairs = querySlots(grid, { preferTimeOfDay: 'morning' });
    expect(pairs.every(p => parseInt(p.slot.time)).valueOf()).toBe(true);
    expect(pairs.map(p => p.slot.time)).toContain('07:00 – 09:00');
    expect(pairs.map(p => p.slot.time)).toContain('08:00 – 10:00');
    expect(pairs.map(p => p.slot.time)).toContain('09:00 – 11:00');
  });

  it('filters by evening time-of-day', () => {
    const pairs = querySlots(grid, { preferTimeOfDay: 'evening' });
    expect(pairs.map(p => p.slot.time)).toContain('18:00 – 20:00');
    expect(pairs.map(p => p.slot.time)).toContain('20:00 – 22:00');
  });

  it('honours limit', () => {
    const pairs = querySlots(grid, { limit: 2 });
    expect(pairs.length).toBe(2);
  });

  it('combining filters narrows results', () => {
    const pairs = querySlots(grid, {
      preferTimeOfDay: 'morning',
      maxPricePln: 5,
    });
    // morning slots: 0, 9.99, 4.99 → only 0 and 4.99 pass.
    expect(pairs.length).toBe(2);
  });
});

describe('findCheapestSlot', () => {
  const grid = normaliseDeliveryGrid(URL, sampleRaw, []);

  it('returns the cheapest slot among available', () => {
    const r = findCheapestSlot(grid)!;
    expect(r.slot.priceValue).toBe(0);
    expect(r.slot.time).toBe('07:00 – 09:00');
  });

  it('respects time-of-day filter', () => {
    const r = findCheapestSlot(grid, { preferTimeOfDay: 'evening' })!;
    expect(r.slot.time).toBe('18:00 – 20:00');
  });

  it('returns null when filter excludes everything', () => {
    const r = findCheapestSlot(grid, { maxPricePln: -1 });
    expect(r).toBeNull();
  });
});

describe('findEarliestSlot', () => {
  const grid = normaliseDeliveryGrid(URL, sampleRaw, []);

  it('returns the earliest available slot', () => {
    const r = findEarliestSlot(grid)!;
    expect(r.day.date).toBe('2025-04-29');
    expect(r.slot.time).toBe('07:00 – 09:00');
  });

  it('skips unavailable slots', () => {
    const onlyOosFirst: RawDay[] = [
      { date: '2025-04-29', dayLabel: 'Wt', slots: [
        { time: '07:00 – 09:00', price: '0,00 zł', status: 'unavailable' },
        { time: '09:00 – 11:00', price: '4,99 zł', status: 'available' },
      ]},
    ];
    const g = normaliseDeliveryGrid(URL, onlyOosFirst, []);
    const r = findEarliestSlot(g)!;
    expect(r.slot.time).toBe('09:00 – 11:00');
  });
});

describe('flattenSlots', () => {
  it('returns N pairs for sample grid', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, []);
    expect(flattenSlots(grid).length).toBe(7);
  });
});

describe('formatGrid', () => {
  it('shows a placeholder when no days were parsed', () => {
    const grid = normaliseDeliveryGrid(URL, [], []);
    const out = formatGrid(grid);
    expect(out).toContain('No delivery days were parsed');
    expect(out).toContain(URL);
  });

  it('renders a markdown-ish summary with markers', () => {
    const grid = normaliseDeliveryGrid(URL, sampleRaw, ['Fuel surcharge applies']);
    const out = formatGrid(grid);
    expect(out).toContain('📅');
    expect(out).toContain('✅');
    expect(out).toContain('⛔');
    expect(out).toContain('Fuel surcharge');
  });

  it('caps slots per day with maxSlotsPerDay', () => {
    const big: RawDay[] = [{
      date: '2025-04-29',
      dayLabel: 'Wt',
      slots: Array.from({ length: 10 }, (_, i) => ({
        time: `0${i}:00 – 0${i+1}:00`.slice(-13),
        price: `${i},00 zł`,
        status: 'available' as const,
      })),
    }];
    const grid = normaliseDeliveryGrid(URL, big, []);
    const out = formatGrid(grid, { maxSlotsPerDay: 3 });
    expect(out).toContain('and 7 more');
  });
});
