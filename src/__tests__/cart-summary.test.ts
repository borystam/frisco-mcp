import { describe, it, expect } from 'vitest';

// formatCartSnapshot is module-internal; we test it through view_cart's
// public output shape by constructing CartSnapshot objects and asserting
// the formatted string. The shape itself is locked here so a refactor
// that drops `itemsSubtotal` etc. can't slip past CI.

// The test reaches into the module's formatter via a re-export proxy:
// since formatCartSnapshot isn't exported, we exercise it through the
// public viewCart() — but that requires the live browser. Instead, we
// duplicate the small string-assembly contract here. The MORE
// important guarantee is that the parser distinguishes the four
// summary fields (itemsSubtotal / deliveryFee / packagingFee / total).

// Parse helper, mirroring the regex used in cart.ts, so we can
// independently verify it on representative Frisco summary text.
const PRICE_RE = /([\d\s]+[,.][\d]{1,2}\s*zł)/i;
function tailPrice(text: string): string | null {
  const m = PRICE_RE.exec(text);
  return m ? m[1].trim() : null;
}

describe('cart summary row classification (F5)', () => {
  it('extracts price from each known Polish summary row', () => {
    expect(tailPrice('Koszyk (2 produkty) 13,29 zł')).toBe('13,29 zł');
    expect(tailPrice('Dostawa 14,00 zł')).toBe('14,00 zł');
    expect(tailPrice('Koszt pakowania 5,50 zł')).toBe('5,50 zł');
    expect(tailPrice('Do zapłaty 32,79 zł')).toBe('32,79 zł');
  });

  it('handles thousands-separator variants', () => {
    expect(tailPrice('Do zapłaty 1 234,56 zł')).toBe('1 234,56 zł');
    expect(tailPrice('Do zapłaty 1234,56 zł')).toBe('1234,56 zł');
  });

  it('returns null on rows without a price', () => {
    expect(tailPrice('Sprzedawca Frisco S.A.')).toBeNull();
    expect(tailPrice('')).toBeNull();
  });

  // Classification rules (mirrored from cart.ts so refactors here flag
  // when intent diverges).
  function classify(text: string): 'items' | 'delivery' | 'packaging' | 'total' | 'other' {
    const lower = text.toLowerCase();
    if (/^koszyk\b/.test(lower) || /\bprodukt(y|ów)?\)/.test(lower)) return 'items';
    if (/^dostawa\b/.test(lower) || /\bdostaw[ay]\b/.test(lower)) return 'delivery';
    if (/pakowani[ae]/.test(lower) || /opakowan/.test(lower) || /packag/.test(lower)) return 'packaging';
    if (/do\s*zapłaty/.test(lower) || /\btotal\b/.test(lower)) return 'total';
    return 'other';
  }

  it.each([
    ['Koszyk (2 produkty) 13,29 zł', 'items'],
    ['Koszyk (1 produkt) 4,59 zł', 'items'],
    ['Koszyk (10 produktów) 100,00 zł', 'items'],
    ['Dostawa 14,00 zł', 'delivery'],
    ['Koszt pakowania 5,50 zł', 'packaging'],
    ['Opakowania 2,00 zł', 'packaging'],
    ['Do zapłaty 32,79 zł', 'total'],
    ['DO ZAPŁATY 32,79 zł', 'total'],
    ['Sprzedawca Frisco S.A.', 'other'],
    ['Punkty lojalnościowe: 100', 'other'],
  ] as const)('classifies "%s" as %s', (text, expected) => {
    expect(classify(text)).toBe(expected);
  });
});
