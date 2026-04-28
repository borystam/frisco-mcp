import { describe, it, expect } from 'vitest';
import {
  parseWeightToGrams,
  parsePricePln,
  computeUnitPricePerKg,
  scoreSearchResults,
  formatScoredResults,
} from '../tools/scoring.js';
import type { SearchResultItem } from '../types.js';

const item = (over: Partial<SearchResultItem>): SearchResultItem => ({
  name: 'Test product',
  url: 'https://www.frisco.pl/pid,1234',
  price: '5,00 zł',
  weight: '500 g',
  available: true,
  ...over,
});

describe('parseWeightToGrams', () => {
  it('parses grams', () => {
    expect(parseWeightToGrams('500 g')).toBe(500);
    expect(parseWeightToGrams('250g')).toBe(250);
  });

  it('parses kilograms', () => {
    expect(parseWeightToGrams('1.5 kg')).toBe(1500);
    expect(parseWeightToGrams('2,5 kg')).toBe(2500);
  });

  it('parses millilitres as grams (treated as same scale)', () => {
    expect(parseWeightToGrams('500 ml')).toBe(500);
    expect(parseWeightToGrams('1l')).toBe(1000);
    expect(parseWeightToGrams('1,5 l')).toBe(1500);
  });

  it('returns null for count-based units', () => {
    expect(parseWeightToGrams('12 szt')).toBeNull();
    expect(parseWeightToGrams('6 szt.')).toBeNull();
    expect(parseWeightToGrams('10 pcs')).toBeNull();
  });

  it('returns null for unparsable / missing input', () => {
    expect(parseWeightToGrams('')).toBeNull();
    expect(parseWeightToGrams(null)).toBeNull();
    expect(parseWeightToGrams(undefined)).toBeNull();
    expect(parseWeightToGrams('big')).toBeNull();
  });

  it('handles non-breaking spaces (Frisco DOM emits these)', () => {
    expect(parseWeightToGrams('500 g')).toBe(500);
  });
});

describe('parsePricePln', () => {
  it('parses Polish-style price strings', () => {
    expect(parsePricePln('12,99 zł')).toBeCloseTo(12.99);
    expect(parsePricePln('5,49zł')).toBeCloseTo(5.49);
  });

  it('parses dot-decimal prices', () => {
    expect(parsePricePln('4.50 zł')).toBeCloseTo(4.5);
    expect(parsePricePln('PLN 4.50')).toBeCloseTo(4.5);
  });

  it('returns null for unparsable input', () => {
    expect(parsePricePln('')).toBeNull();
    expect(parsePricePln(null)).toBeNull();
    expect(parsePricePln(undefined)).toBeNull();
    expect(parsePricePln('darmowy')).toBeNull();
  });
});

describe('computeUnitPricePerKg', () => {
  it('returns PLN per kg for 500g item priced 5 zł → 10', () => {
    expect(computeUnitPricePerKg('5,00 zł', '500 g')).toBeCloseTo(10);
  });

  it('returns PLN per kg for 1.5 kg item priced 30 zł → 20', () => {
    expect(computeUnitPricePerKg('30 zł', '1.5 kg')).toBeCloseTo(20);
  });

  it('returns PLN per L for 750 ml item priced 6 zł → 8', () => {
    expect(computeUnitPricePerKg('6,00 zł', '750 ml')).toBeCloseTo(8);
  });

  it('returns null when weight cannot be parsed (count-based unit)', () => {
    expect(computeUnitPricePerKg('12,00 zł', '6 szt')).toBeNull();
  });

  it('returns null when price is missing', () => {
    expect(computeUnitPricePerKg(null, '500 g')).toBeNull();
  });
});

describe('scoreSearchResults — basic ranking', () => {
  it('ranks by unit price by default (cheaper unit price wins)', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Cheap milk 1L', price: '4,00 zł', weight: '1 l' }),
      item({ name: 'Expensive milk 1L', price: '8,00 zł', weight: '1 l' }),
      item({ name: 'Mid milk 1L', price: '6,00 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, {});
    const cheap = scored.find(s => s.name === 'Cheap milk 1L')!;
    const expensive = scored.find(s => s.name === 'Expensive milk 1L')!;
    expect(cheap.score).toBeGreaterThan(expensive.score);
  });

  it('zeroes the score for items containing an avoided keyword', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Mleko UHT 1L', price: '4,00 zł', weight: '1 l' }),
      item({ name: 'Mleko świeże 1L', price: '4,50 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, { avoid: ['UHT'] });
    const uht = scored.find(s => s.name === 'Mleko UHT 1L')!;
    expect(uht.score).toBe(0);
    expect(uht.reasons).toContain('contains avoided keyword "uht"');
  });

  it('zeroes the score for items missing a required keyword', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Mleko świeże 1L', price: '4,50 zł', weight: '1 l' }),
      item({ name: 'Mleko UHT 1L', price: '4,00 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, { must: ['świeże'] });
    const uht = scored.find(s => s.name === 'Mleko UHT 1L')!;
    expect(uht.score).toBe(0);
  });

  it('rewards preferred keyword matches', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Mleko bio ekologiczne 1L', price: '6,00 zł', weight: '1 l' }),
      item({ name: 'Mleko zwykłe 1L', price: '6,00 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, {
      preferKeywords: ['bio', 'ekologiczne'],
      keywordWeight: 1,
      unitPriceWeight: 0,
      packSizeWeight: 0,
      availabilityWeight: 0,
    });
    const bio = scored.find(s => s.name === 'Mleko bio ekologiczne 1L')!;
    const reg = scored.find(s => s.name === 'Mleko zwykłe 1L')!;
    expect(bio.score).toBeGreaterThan(reg.score);
  });

  it('penalises unavailable items via availability weight', () => {
    const items: SearchResultItem[] = [
      item({ name: 'In stock 1L', price: '4,00 zł', weight: '1 l', available: true }),
      item({ name: 'Out of stock 1L', price: '4,00 zł', weight: '1 l', available: false }),
    ];
    const scored = scoreSearchResults(items, {});
    const avail = scored.find(s => s.name === 'In stock 1L')!;
    const oos = scored.find(s => s.name === 'Out of stock 1L')!;
    expect(avail.score).toBeGreaterThan(oos.score);
    expect(oos.reasons).toContain('unavailable');
  });

  it('rewards pack sizes close to a target', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Almost target 480g', price: '5,00 zł', weight: '480 g' }),
      item({ name: 'Far target 200g', price: '5,00 zł', weight: '200 g' }),
    ];
    const scored = scoreSearchResults(items, {
      targetWeightGrams: 500,
      packSizeWeight: 1,
      unitPriceWeight: 0,
      keywordWeight: 0,
      availabilityWeight: 0,
    });
    const close = scored.find(s => s.name === 'Almost target 480g')!;
    const far = scored.find(s => s.name === 'Far target 200g')!;
    expect(close.score).toBeGreaterThan(far.score);
  });
});

describe('scoreSearchResults — breakdown integrity', () => {
  it('returns breakdown components in [0, 1]', () => {
    const items: SearchResultItem[] = [
      item({ name: 'A', price: '4,00 zł', weight: '500 g' }),
      item({ name: 'B', price: '8,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    for (const s of scored) {
      for (const v of Object.values(s.breakdown)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns score in [0, 100]', () => {
    const items: SearchResultItem[] = [
      item({ name: 'A', price: '4,00 zł', weight: '500 g' }),
      item({ name: 'B', price: '8,00 zł', weight: '500 g' }),
      item({ name: 'C', price: '12,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    for (const s of scored) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('records unit price in PLN/kg on each result', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Half-kilo @ 5 PLN', price: '5,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    expect(scored[0].unitPricePerKg).toBeCloseTo(10);
    expect(scored[0].weightGrams).toBe(500);
  });

  it('returns 1 for a single result with default weights (no comparison range)', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Only one', price: '5,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    // unit-price has no range; defaults to 1
    expect(scored[0].breakdown.unitPrice).toBe(1);
  });
});

describe('scoreSearchResults — edge cases', () => {
  it('handles missing price gracefully (no NaN scores)', () => {
    const items: SearchResultItem[] = [
      item({ name: 'No price', price: '', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    expect(scored[0].score).not.toBeNaN();
  });

  it('handles missing weight gracefully', () => {
    const items: SearchResultItem[] = [
      item({ name: 'No weight', price: '5,00 zł', weight: '' }),
    ];
    const scored = scoreSearchResults(items, {});
    expect(scored[0].score).not.toBeNaN();
    expect(scored[0].unitPricePerKg).toBeNull();
  });

  it('combines must and avoid: must-pass AND avoid-fail → 0', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Mleko UHT 1L', price: '4,00 zł', weight: '1 l' }),
      item({ name: 'Mleko świeże 1L', price: '5,00 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, {
      must: ['mleko'],
      avoid: ['uht'],
    });
    const uht = scored.find(s => s.name === 'Mleko UHT 1L')!;
    expect(uht.score).toBe(0);
  });

  it('treats empty must/avoid as "no constraint"', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Anything', price: '4,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, { must: [], avoid: [] });
    expect(scored[0].breakdown.mustAvoid).toBe(1);
  });

  it('case-insensitive matching for must/avoid/preferKeywords', () => {
    const items: SearchResultItem[] = [
      item({ name: 'BIO Mleko 1L', price: '4,00 zł', weight: '1 l' }),
    ];
    const scored = scoreSearchResults(items, {
      must: ['mleko'],
      avoid: ['UHT'],
      preferKeywords: ['bio'],
    });
    expect(scored[0].breakdown.mustAvoid).toBe(1);
    expect(scored[0].breakdown.keyword).toBe(1);
  });

  it('does not divide by zero when all unit prices are equal', () => {
    const items: SearchResultItem[] = [
      item({ name: 'A', price: '4,00 zł', weight: '500 g' }),
      item({ name: 'B', price: '4,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    for (const s of scored) {
      expect(s.score).not.toBeNaN();
      expect(s.breakdown.unitPrice).toBe(1);
    }
  });
});

describe('formatScoredResults', () => {
  it('returns a placeholder when no results', () => {
    expect(formatScoredResults('mleko', [], 5)).toContain('No products found');
  });

  it('sorts by score desc and applies topN', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Cheap', price: '2,00 zł', weight: '500 g' }),
      item({ name: 'Mid', price: '4,00 zł', weight: '500 g' }),
      item({ name: 'Expensive', price: '8,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    const formatted = formatScoredResults('q', scored, 2);
    const idxCheap = formatted.indexOf('Cheap');
    const idxMid = formatted.indexOf('Mid');
    const idxExp = formatted.indexOf('Expensive');
    expect(idxCheap).toBeGreaterThan(-1);
    expect(idxMid).toBeGreaterThan(-1);
    expect(idxExp).toBe(-1); // beyond topN
    expect(idxCheap).toBeLessThan(idxMid);
  });

  it('breaks ties by unit price ascending', () => {
    const items: SearchResultItem[] = [
      item({ name: 'A', price: '5,00 zł', weight: '500 g' }), // 10 PLN/kg
      item({ name: 'B', price: '4,00 zł', weight: '500 g' }), //  8 PLN/kg
    ];
    const scored = scoreSearchResults(items, {
      keywordWeight: 1,
      unitPriceWeight: 0,
      packSizeWeight: 0,
      availabilityWeight: 0,
    });
    // both score 1 on keyword, total 1; tie-break should put B (cheaper) first.
    const formatted = formatScoredResults('q', scored, 5);
    expect(formatted.indexOf('B')).toBeLessThan(formatted.indexOf('A'));
  });

  it('shows availability marker for unavailable items', () => {
    const items: SearchResultItem[] = [
      item({ name: 'Out', price: '5,00 zł', weight: '500 g', available: false }),
    ];
    const scored = scoreSearchResults(items, {});
    const formatted = formatScoredResults('q', scored, 5);
    expect(formatted).toContain('NIEDOSTĘPNY');
  });

  it('renders unit-price hint when computable', () => {
    const items: SearchResultItem[] = [
      item({ name: 'A', price: '5,00 zł', weight: '500 g' }),
    ];
    const scored = scoreSearchResults(items, {});
    expect(formatScoredResults('q', scored, 5)).toContain('PLN/kg');
  });
});
