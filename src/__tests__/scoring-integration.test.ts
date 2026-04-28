import { describe, it, expect } from 'vitest';
import {
  scoreSearchResults,
  formatScoredResults,
} from '../tools/scoring.js';
import type { SearchResultItem } from '../types.js';

// Higher-level scenarios that exercise typical user requests.

describe('scoring scenarios — milk shopping', () => {
  it('"cheapest fresh milk, no UHT, 1L preferred" → ranks fresh-1L items first', () => {
    const items: SearchResultItem[] = [
      {
        name: 'Mleko świeże 3,2% 1L',
        url: 'u1',
        price: '4,49 zł',
        weight: '1 l',
        available: true,
      },
      {
        name: 'Mleko UHT 2% 1L',
        url: 'u2',
        price: '3,99 zł',
        weight: '1 l',
        available: true,
      },
      {
        name: 'Mleko świeże 1.5% 500ml',
        url: 'u3',
        price: '2,99 zł',
        weight: '500 ml',
        available: true,
      },
    ];
    const scored = scoreSearchResults(items, {
      must: ['mleko'],
      avoid: ['UHT'],
      preferKeywords: ['świeże'],
      targetWeightGrams: 1000,
      packSizeWeight: 0.3,
    });
    const fresh1L = scored.find(s => s.name === 'Mleko świeże 3,2% 1L')!;
    const uht = scored.find(s => s.name === 'Mleko UHT 2% 1L')!;
    const fresh500 = scored.find(s => s.name === 'Mleko świeże 1.5% 500ml')!;

    expect(uht.score).toBe(0); // hard zero for avoided keyword
    expect(fresh1L.score).toBeGreaterThan(fresh500.score);
  });
});

describe('scoring scenarios — bulk staples', () => {
  it('"largest pack of rice, lowest PLN/kg" → biggest pack at best unit price wins', () => {
    const items: SearchResultItem[] = [
      { name: 'Ryż 1 kg', url: 'u1', price: '8,00 zł', weight: '1 kg', available: true },
      { name: 'Ryż 5 kg', url: 'u2', price: '32,00 zł', weight: '5 kg', available: true }, // 6.4/kg
      { name: 'Ryż 500 g', url: 'u3', price: '5,00 zł', weight: '500 g', available: true }, // 10/kg
    ];
    const scored = scoreSearchResults(items, {
      must: ['ryż'],
      unitPriceWeight: 0.7,
      packSizeWeight: 0.3,
      targetWeightGrams: 5000,
      keywordWeight: 0,
      availabilityWeight: 0,
    });
    const sorted = [...scored].sort((a, b) => b.score - a.score);
    expect(sorted[0].name).toBe('Ryż 5 kg');
  });
});

describe('scoring scenarios — availability matters', () => {
  it('available item beats unavailable cheaper item when availability is weighted', () => {
    const items: SearchResultItem[] = [
      {
        name: 'Cheap unavailable',
        url: 'u1',
        price: '3,00 zł',
        weight: '500 g',
        available: false,
      },
      {
        name: 'Mid available',
        url: 'u2',
        price: '5,00 zł',
        weight: '500 g',
        available: true,
      },
    ];
    const scored = scoreSearchResults(items, {
      unitPriceWeight: 0.3,
      availabilityWeight: 0.7,
      keywordWeight: 0,
    });
    const avail = scored.find(s => s.name === 'Mid available')!;
    const unavail = scored.find(s => s.name === 'Cheap unavailable')!;
    expect(avail.score).toBeGreaterThan(unavail.score);
  });
});

describe('formatScoredResults integration', () => {
  it('output is human-readable and includes top score, name, price, unit', () => {
    const items: SearchResultItem[] = [
      { name: 'Ryż 5 kg', url: 'u', price: '32,00 zł', weight: '5 kg', available: true },
    ];
    const scored = scoreSearchResults(items, {});
    const out = formatScoredResults('ryż', scored, 5);
    expect(out).toContain('Ryż 5 kg');
    expect(out).toContain('32,00 zł');
    expect(out).toContain('PLN/kg');
  });
});
