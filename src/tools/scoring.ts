// Scoring helpers for ranking search results by user-supplied criteria.
//
// `search_products_scored` lets the model search Frisco and weight the
// returned products by a small, fixed feature set: unit price (PLN per
// kg/L/szt), pack weight, availability, name-keyword match, and the
// presence of "must" / "avoid" tokens in the product name. Scoring is
// deterministic and explained: each result carries a score (0–100), a
// per-criterion breakdown, and a one-line reason string.
//
// We intentionally keep this lightweight — no LLM call, no external
// embedding service, no heuristic crawl beyond the base search-results
// page. Inputs come from the same DOM as `search_products`, so the
// extra cost is parsing-only.

import type { SearchResultItem } from '../types.js';

export interface ScoringCriteria {
  /** Words that must appear in the product name (case-insensitive substring). */
  must?: string[];
  /** Words that must NOT appear in the product name (case-insensitive substring). */
  avoid?: string[];
  /** Free-form preference keywords; partial matches add small bonuses. */
  preferKeywords?: string[];
  /** Weight in [0,1] for unit-price (lower price → higher score). Default 0.4. */
  unitPriceWeight?: number;
  /** Weight in [0,1] for pack-weight closeness to `targetWeight`. Default 0. */
  packSizeWeight?: number;
  /** Target pack size in grams (or ml; treated as same scale). */
  targetWeightGrams?: number;
  /** Weight for keyword/preference match. Default 0.3. */
  keywordWeight?: number;
  /** Weight for availability. Default 0.3. Unavailable items get this fraction subtracted. */
  availabilityWeight?: number;
}

export interface ScoredProduct extends SearchResultItem {
  score: number;
  unitPricePerKg: number | null;
  weightGrams: number | null;
  reasons: string[];
  breakdown: {
    unitPrice: number;
    packSize: number;
    keyword: number;
    availability: number;
    mustAvoid: number;
  };
}

const UNIT_TO_GRAMS: Record<string, number> = {
  g: 1,
  ml: 1,
  kg: 1000,
  l: 1000,
};

/**
 * Parse a Frisco weight string like "500 g", "1.5 kg", "750ml", "12 szt"
 * into grams (or ml — same scale). Returns null for "szt" / "pcs" / unparsable
 * strings; the caller treats null as "no weight signal".
 */
export function parseWeightToGrams(weight: string | null | undefined): number | null {
  if (!weight) return null;
  const cleaned = weight.replace(/ /g, ' ').trim().toLowerCase();
  // "12 szt" / "6 szt." / "10 pcs" → null (count, not weight)
  if (/\b(szt|pcs)\b/.test(cleaned)) return null;
  const match = cleaned.match(/([\d]+(?:[.,]\d+)?)\s*(g|ml|kg|l)\b/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(',', '.'));
  const unit = match[2];
  const factor = UNIT_TO_GRAMS[unit];
  if (!factor || !isFinite(value)) return null;
  return value * factor;
}

/**
 * Parse a Frisco price string like "12,99 zł", "PLN 4.50", "5,49zł" into
 * a numeric value in PLN. Returns null on unparsable input.
 */
export function parsePricePln(price: string | null | undefined): number | null {
  if (!price) return null;
  const match = price.replace(/ /g, ' ').match(/([\d]+(?:[.,]\d+)?)\s*(?:zł|pln)?/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(',', '.'));
  return isFinite(value) ? value : null;
}

/**
 * Compute unit price in PLN per kg (for items priced by mass) or PLN per L
 * (for items priced by volume). Returns null when either input is missing.
 */
export function computeUnitPricePerKg(
  price: string | null | undefined,
  weight: string | null | undefined,
): number | null {
  const priceVal = parsePricePln(price);
  const grams = parseWeightToGrams(weight);
  if (priceVal == null || grams == null || grams <= 0) return null;
  // grams / 1000 = kg (or L); price / kg.
  return priceVal / (grams / 1000);
}

function clamp01(x: number): number {
  if (!isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function defaultWeights(c: ScoringCriteria): Required<
  Pick<
    ScoringCriteria,
    'unitPriceWeight' | 'packSizeWeight' | 'keywordWeight' | 'availabilityWeight'
  >
> {
  return {
    unitPriceWeight: c.unitPriceWeight ?? 0.4,
    packSizeWeight: c.packSizeWeight ?? 0,
    keywordWeight: c.keywordWeight ?? 0.3,
    availabilityWeight: c.availabilityWeight ?? 0.3,
  };
}

/**
 * Pure function that scores a list of search results against a criteria
 * object. Exported separately from the MCP-tool wrapper so it can be
 * unit-tested without spinning up a browser.
 */
export function scoreSearchResults(
  items: SearchResultItem[],
  criteria: ScoringCriteria,
): ScoredProduct[] {
  const weights = defaultWeights(criteria);
  const must = (criteria.must ?? []).map(s => s.toLowerCase()).filter(Boolean);
  const avoid = (criteria.avoid ?? []).map(s => s.toLowerCase()).filter(Boolean);
  const preferred = (criteria.preferKeywords ?? []).map(s => s.toLowerCase()).filter(Boolean);

  const enriched = items.map(item => {
    const grams = parseWeightToGrams(item.weight);
    const unitPrice = computeUnitPricePerKg(item.price, item.weight);
    return { item, grams, unitPrice };
  });

  // Determine the unit-price normalisation envelope from the candidate set.
  const unitPrices = enriched.map(e => e.unitPrice).filter((x): x is number => x != null);
  const minUP = unitPrices.length ? Math.min(...unitPrices) : 0;
  const maxUP = unitPrices.length ? Math.max(...unitPrices) : 0;
  const upRange = maxUP - minUP;

  const target = criteria.targetWeightGrams;

  return enriched.map(({ item, grams, unitPrice }) => {
    const reasons: string[] = [];
    const nameLower = item.name.toLowerCase();

    let mustAvoidScore = 0;
    let mustAvoidPenalty = false;
    for (const tok of must) {
      if (!nameLower.includes(tok)) {
        mustAvoidPenalty = true;
        reasons.push(`missing required keyword "${tok}"`);
      }
    }
    for (const tok of avoid) {
      if (nameLower.includes(tok)) {
        mustAvoidPenalty = true;
        reasons.push(`contains avoided keyword "${tok}"`);
      }
    }
    if (must.length || avoid.length) {
      mustAvoidScore = mustAvoidPenalty ? 0 : 1;
    } else {
      mustAvoidScore = 1;
    }

    let unitPriceScore = 0;
    if (weights.unitPriceWeight > 0 && unitPrice != null && upRange > 0) {
      // Lower unit price → score closer to 1.
      unitPriceScore = clamp01(1 - (unitPrice - minUP) / upRange);
      reasons.push(`unit ${unitPrice.toFixed(2)} PLN/kg (best ${minUP.toFixed(2)})`);
    } else if (weights.unitPriceWeight > 0 && unitPrice != null && upRange === 0) {
      unitPriceScore = 1;
      reasons.push(`unit ${unitPrice.toFixed(2)} PLN/kg (only data point)`);
    }

    let packSizeScore = 0;
    if (weights.packSizeWeight > 0 && target != null && grams != null) {
      const diff = Math.abs(grams - target) / target;
      packSizeScore = clamp01(1 - diff);
      reasons.push(`pack ${grams}g vs target ${target}g`);
    }

    let keywordScore = 0;
    if (preferred.length) {
      const hits = preferred.filter(k => nameLower.includes(k));
      keywordScore = hits.length / preferred.length;
      if (hits.length) reasons.push(`matched ${hits.length}/${preferred.length} preferences`);
    } else {
      keywordScore = 1;
    }

    const availabilityScore = item.available ? 1 : 0;
    if (!item.available) reasons.push('unavailable');

    const components =
      weights.unitPriceWeight * unitPriceScore +
      weights.packSizeWeight * packSizeScore +
      weights.keywordWeight * keywordScore +
      weights.availabilityWeight * availabilityScore;

    const totalWeight =
      weights.unitPriceWeight +
      weights.packSizeWeight +
      weights.keywordWeight +
      weights.availabilityWeight;

    let score = totalWeight > 0 ? components / totalWeight : 0;
    score *= mustAvoidScore;

    return {
      ...item,
      score: Math.round(score * 1000) / 10,
      unitPricePerKg: unitPrice,
      weightGrams: grams,
      reasons,
      breakdown: {
        unitPrice: Math.round(unitPriceScore * 100) / 100,
        packSize: Math.round(packSizeScore * 100) / 100,
        keyword: Math.round(keywordScore * 100) / 100,
        availability: Math.round(availabilityScore * 100) / 100,
        mustAvoid: mustAvoidScore,
      },
    };
  });
}

/**
 * Format scored results as a markdown-style block for the MCP tool reply.
 * Sorted by score descending; ties broken by unit price (cheaper first),
 * then by name (stable).
 */
export function formatScoredResults(
  query: string,
  scored: ScoredProduct[],
  topN: number,
): string {
  const sorted = [...scored].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aUp = a.unitPricePerKg ?? Number.POSITIVE_INFINITY;
    const bUp = b.unitPricePerKg ?? Number.POSITIVE_INFINITY;
    if (aUp !== bUp) return aUp - bUp;
    return a.name.localeCompare(b.name);
  });
  const limited = sorted.slice(0, topN);
  if (limited.length === 0) return `❌ No products found for "${query}".`;

  const lines = [`🏆 Scored results for "${query}":\n`];
  for (let i = 0; i < limited.length; i++) {
    const r = limited[i];
    const weightPart = r.weight ? ` [${r.weight}]` : '';
    const pricePart = r.price ? ` | ${r.price}` : '';
    const upPart = r.unitPricePerKg != null ? ` (${r.unitPricePerKg.toFixed(2)} PLN/kg)` : '';
    const availPart = r.available ? '' : ' ⚠️ NIEDOSTĘPNY';
    lines.push(
      `${i + 1}. [${r.score.toFixed(1)}] ${r.name}${weightPart}${pricePart}${upPart}${availPart}`,
    );
    if (r.reasons.length) {
      lines.push(`     why: ${r.reasons.join('; ')}`);
    }
  }
  return lines.join('\n');
}
