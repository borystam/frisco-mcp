import { getPage, getContext, productCache, setLastSearchContext } from '../browser.js';
import { ensureLoggedIn } from '../auth.js';
import { formatProductInfo, extractProductPageInfoFromHtml, extractReviewsFromHtml, formatReviews } from './helpers.js';
import {
  scoreSearchResults,
  formatScoredResults,
  type ScoringCriteria,
} from './scoring.js';
import type { Product, SearchResultItem } from '../types.js';

// Bounds on topN. Below 1 is nonsensical; Frisco's own page caps at ~24,
// so anything above that is wasted bandwidth.
const TOPN_MIN = 1;
const TOPN_MAX = 24;
const TOPN_DEFAULT = 5;

export function clampTopN(topN: number | undefined, fallback: number = TOPN_DEFAULT): number {
  if (topN === undefined || !Number.isFinite(topN)) return fallback;
  return Math.max(TOPN_MIN, Math.min(TOPN_MAX, Math.floor(topN)));
}

export async function searchProducts(query: string, topN: number = TOPN_DEFAULT): Promise<string> {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return '❌ Search query is required (got empty string).';
  }
  const limit = clampTopN(topN);
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  await page.getByRole('textbox', { name: 'Wyszukaj' }).click();
  const searchInput = page.getByRole('textbox', { name: 'Jakiego produktu szukasz?' });
  await searchInput.fill(query);
  await searchInput.press('Enter');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);

  try {
    const products = (await page.evaluate((limit: number) => {
      function notInSidebar(el: HTMLElement) {
        let node = el.parentElement;
        while (node) {
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('cart') || cls.includes('basket') || cls.includes('mini-cart')) return false;
          node = node.parentElement;
        }
        const rect = el.getBoundingClientRect();
        return rect.left <= window.innerWidth * 0.65;
      }

      const boxes = Array.from(document.querySelectorAll<HTMLElement>('.product-box_holder'))
        .filter(el => el.offsetParent !== null && notInSidebar(el))
        .slice(0, limit);

      return boxes.map(box => {
        const nameEl = box.querySelector<HTMLAnchorElement>('a[title]');
        const name = nameEl ? nameEl.title : '?';
        const productLink = box.querySelector<HTMLAnchorElement>('a[href*="/pid,"][title]');
        const href = productLink ? productLink.getAttribute('href') || productLink.href : null;
        const priceEl = box.querySelector<HTMLElement>('[class*="price"], [class*="Price"]');
        const price = priceEl ? priceEl.innerText.trim().replace(/\\s+/g, ' ') : '';

        let weight = '';
        const weightEl = box.querySelector<HTMLElement>('.f-pc-weight__text');
        if (weightEl) {
          const raw = weightEl.innerText.trim().replace(/\\s+/g, ' ');
          const wm = raw.match(/^~?([\d.,]+\s*(?:g|ml|kg|l|szt\.?|pcs)\b)/i);
          if (wm) weight = wm[1];
        }
        if (!weight) {
          const imgEl = box.querySelector<HTMLImageElement>('img[alt]');
          if (imgEl?.alt) {
            const am = imgEl.alt.match(/([\d.,]+\s*(?:g|ml|kg|l|szt\.?|pcs))\s*$/i);
            if (am) weight = am[1].replace(/\u00a0/g, ' ');
          }
        }

        const unavailable = !!box.querySelector('.unavailable-info') ||
          !!box.querySelector('article.unavailable');

        return { name, href, price, weight, available: !unavailable };
      });
    }, limit)) as Array<{
      name: string;
      href: string | null;
      price: string;
      weight: string;
      available: boolean;
    }>;

    if (!products.length) return `❌ No products found for: "${query}"`;

    const searchResults: SearchResultItem[] = [];
    const searchUrl = page.url();

    const lines = [`🔍 Search results for "${query}" (saved context):\n`];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const href = p.href;
      const fullUrl = typeof href === 'string'
        ? (href.startsWith('http') ? href : `https://www.frisco.pl${href}`)
        : null;
      if (p.available && typeof href === 'string') {
        const cachedProduct: Product = {
          name: p.name,
          url: fullUrl!,
          price: p.price || '',
          weight: p.weight || null,
          macros: {},
          ingredients: null,
        };
        productCache.set(p.name, cachedProduct);
      }
      searchResults.push({
        name: p.name,
        url: fullUrl,
        price: p.price || '',
        weight: p.weight || '',
        available: p.available,
      });
      const weightPart = p.weight ? ` [${p.weight}]` : '';
      const pricePart = p.price ? ` | ${p.price}` : '';
      const availPart = p.available ? '' : ' ⚠️ NIEDOSTĘPNY';
      lines.push(`${i + 1}. ${p.name}${weightPart}${pricePart}${availPart}`);
    }
    setLastSearchContext({
      query,
      searchUrl,
      results: searchResults,
      updatedAt: Date.now(),
    });
    lines.push('');
    lines.push(`🔗 Search URL: ${searchUrl}`);
    return lines.join('\n');
  } catch (err) {
    return `❌ Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function getProductInfo(query: string): Promise<string> {
  const cached = productCache.get(query)
    ?? Array.from(productCache.values()).find(
      p => p.name.toLowerCase() === query.toLowerCase()
    );
  if (cached?.macros && Object.keys(cached.macros).length > 0) {
    return formatProductInfo(cached);
  }

  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  let productUrl: string | null = null;
  try {
    await page.getByRole('textbox', { name: 'Wyszukaj' }).click();
    const searchInput = page.getByRole('textbox', { name: 'Jakiego produktu szukasz?' });
    await searchInput.fill(query);
    await searchInput.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2_000);

    productUrl = (await page.evaluate(() => {
      function notInSidebar(el: HTMLElement) {
        let node = el.parentElement;
        while (node) {
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('cart') || cls.includes('basket') || cls.includes('mini-cart')) return false;
          node = node.parentElement;
        }
        return el.getBoundingClientRect().left <= window.innerWidth * 0.65;
      }
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/pid,"][title]'))
        .find(el => el.offsetParent !== null && notInSidebar(el));
      return link ? link.href : null;
    })) as string | null;
  } catch (err) {
    return `❌ Search failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (!productUrl) return `❌ No product found for: "${query}"`;

  const fullUrl = productUrl.startsWith('http')
    ? productUrl
    : 'https://www.frisco.pl' + productUrl;

  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    for (const label of ['Wartości odżywcze', 'Skład i alergeny']) {
      try {
        await page.getByText(label, { exact: true }).first().click({ timeout: 2_000 });
        await page.waitForTimeout(800);
      } catch {}
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);

    const html = await page.content();
    const info = extractProductPageInfoFromHtml(html);
    const product: Product = {
      name: info.name || query,
      url: fullUrl,
      price: info.price,
      originalPrice: info.originalPrice,
      unitPrice: info.unitPrice,
      weight: info.weight,
      macros: info.macros,
      ingredients: info.ingredients,
    };
    productCache.set(query, product);
    return formatProductInfo(product);
  } catch (err) {
    return `❌ Failed to extract product info: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Search Frisco for `query`, then rank the visible results against
 * `criteria` (must/avoid/preferKeywords + unit-price/pack-size/availability
 * weights). Returns a formatted markdown-ish block; also caches the
 * Product entries under their names so follow-up tools can use them.
 *
 * Scoring details live in src/tools/scoring.ts and are unit-tested in
 * src/__tests__/scoring.test.ts. This wrapper performs the same DOM
 * scrape as `searchProducts`, then hands raw items to the pure scorer.
 */
export async function searchProductsScored(
  query: string,
  criteria: ScoringCriteria,
  topN: number = TOPN_DEFAULT,
): Promise<string> {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return '❌ Search query is required (got empty string).';
  }
  const effectiveTopN = clampTopN(topN);
  // Sanity-check the criteria object: packSizeWeight > 0 without
  // targetWeightGrams is a no-op that the user almost certainly didn't
  // intend; surface it instead of silently scoring 0 for that component.
  if (
    criteria &&
    typeof criteria.packSizeWeight === 'number' &&
    criteria.packSizeWeight > 0 &&
    (criteria.targetWeightGrams === undefined ||
      !Number.isFinite(criteria.targetWeightGrams) ||
      (criteria.targetWeightGrams ?? 0) <= 0)
  ) {
    return '❌ packSizeWeight > 0 requires targetWeightGrams (positive). Set both, or set packSizeWeight to 0.';
  }
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  await page.getByRole('textbox', { name: 'Wyszukaj' }).click();
  const searchInput = page.getByRole('textbox', { name: 'Jakiego produktu szukasz?' });
  await searchInput.fill(query);
  await searchInput.press('Enter');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2_000);

  // We over-scrape (default 25) so the scorer has a real candidate set;
  // the scorer + topN trim to user-visible size.
  const candidatePoolSize = 25;

  try {
    const products = (await page.evaluate((limit: number) => {
      function notInSidebar(el: HTMLElement) {
        let node = el.parentElement;
        while (node) {
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('cart') || cls.includes('basket') || cls.includes('mini-cart')) return false;
          node = node.parentElement;
        }
        const rect = el.getBoundingClientRect();
        return rect.left <= window.innerWidth * 0.65;
      }

      const boxes = Array.from(document.querySelectorAll<HTMLElement>('.product-box_holder'))
        .filter(el => el.offsetParent !== null && notInSidebar(el))
        .slice(0, limit);

      return boxes.map(box => {
        const nameEl = box.querySelector<HTMLAnchorElement>('a[title]');
        const name = nameEl ? nameEl.title : '?';
        const productLink = box.querySelector<HTMLAnchorElement>('a[href*="/pid,"][title]');
        const href = productLink ? productLink.getAttribute('href') || productLink.href : null;
        const priceEl = box.querySelector<HTMLElement>('[class*="price"], [class*="Price"]');
        const price = priceEl ? priceEl.innerText.trim().replace(/\s+/g, ' ') : '';

        let weight = '';
        const weightEl = box.querySelector<HTMLElement>('.f-pc-weight__text');
        if (weightEl) {
          const raw = weightEl.innerText.trim().replace(/\s+/g, ' ');
          const wm = raw.match(/^~?([\d.,]+\s*(?:g|ml|kg|l|szt\.?|pcs)\b)/i);
          if (wm) weight = wm[1];
        }
        if (!weight) {
          const imgEl = box.querySelector<HTMLImageElement>('img[alt]');
          if (imgEl?.alt) {
            const am = imgEl.alt.match(/([\d.,]+\s*(?:g|ml|kg|l|szt\.?|pcs))\s*$/i);
            if (am) weight = am[1].replace(/ /g, ' ');
          }
        }

        const unavailable = !!box.querySelector('.unavailable-info') ||
          !!box.querySelector('article.unavailable');

        return { name, href, price, weight, available: !unavailable };
      });
    }, candidatePoolSize)) as Array<{
      name: string;
      href: string | null;
      price: string;
      weight: string;
      available: boolean;
    }>;

    if (!products.length) return `❌ No products found for: "${query}"`;

    const searchResults: SearchResultItem[] = [];
    const searchUrl = page.url();

    for (const p of products) {
      const fullUrl = typeof p.href === 'string'
        ? (p.href.startsWith('http') ? p.href : `https://www.frisco.pl${p.href}`)
        : null;
      if (p.available && fullUrl) {
        const cachedProduct: Product = {
          name: p.name,
          url: fullUrl,
          price: p.price || '',
          weight: p.weight || null,
          macros: {},
          ingredients: null,
        };
        productCache.set(p.name, cachedProduct);
      }
      searchResults.push({
        name: p.name,
        url: fullUrl,
        price: p.price || '',
        weight: p.weight || '',
        available: p.available,
      });
    }
    setLastSearchContext({
      query,
      searchUrl,
      results: searchResults,
      updatedAt: Date.now(),
    });

    const scored = scoreSearchResults(searchResults, criteria);
    const formatted = formatScoredResults(query, scored, effectiveTopN);
    return `${formatted}\n\n🔗 Search URL: ${searchUrl}`;
  } catch (err) {
    return `❌ Search error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function getProductReviews(query: string, limit: number = 5): Promise<string> {
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  try {
    await page.getByRole('textbox', { name: 'Wyszukaj' }).click();
    const searchInput = page.getByRole('textbox', { name: 'Jakiego produktu szukasz?' });
    await searchInput.fill(query);
    await searchInput.press('Enter');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2_000);

    const productUrl: string | null = await page.evaluate(() => {
      function notInSidebar(el: HTMLElement) {
        let node = el.parentElement;
        while (node) {
          const cls = (node.className || '').toString().toLowerCase();
          if (cls.includes('cart') || cls.includes('basket') || cls.includes('mini-cart')) return false;
          node = node.parentElement;
        }
        return el.getBoundingClientRect().left <= window.innerWidth * 0.65;
      }
      const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/pid,"][title]'))
        .find(el => el.offsetParent !== null && notInSidebar(el));
      return link ? link.href : null;
    });

    if (!productUrl) return `❌ Nie znaleziono produktu: "${query}"`;

    const fullUrl = productUrl.startsWith('http')
      ? productUrl
      : 'https://www.frisco.pl' + productUrl;

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2_000);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);

    const html = await page.content();
    const data = extractReviewsFromHtml(html);
    return formatReviews(data, limit);
  } catch (err) {
    return `❌ Błąd pobierania opinii: ${err instanceof Error ? err.message : String(err)}`;
  }
}
