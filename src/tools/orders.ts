// Orders / order-history tool.
//
// Reads the user's past orders from /stn,settings/sub,history (Frisco moved
// the page from the older /stn,user-orders some time before 2026-04-29).
// Frisco renders the list as cards with order ID, placed-at date, status,
// total, and a delivery date. We surface that as a JSON-friendly
// structure so the model can answer "when was my last order", "what did
// I get last Tuesday", "spent how much in March".
//
// We do NOT click into individual orders for line-item detail in this
// pass — Frisco's order-detail page is gated by an extra confirmation
// step on some accounts. Listing-level data is enough for "find by
// date" and "spend summary" questions, which is the user's stated need.

import { getPage, getContext } from '../browser.js';
import { ensureLoggedIn } from '../auth.js';

const ORDERS_URL = 'https://www.frisco.pl/stn,settings/sub,history';
// Legacy URL kept for diagnosis: if the live site ever redirects to it
// the parser will detect that and surface the page-not-found error
// rather than silently returning "no orders".
const LEGACY_ORDERS_URL = 'https://www.frisco.pl/stn,user-orders';
const SETTLE_MS = 2_000;

export interface OrderSummary {
  /** Frisco's user-facing order id (e.g. "FRI-12345678"). */
  orderId: string;
  /** ISO-ish date the order was placed. May be null if not parseable. */
  placedAt: string | null;
  /** Delivery date as displayed on the card. */
  deliveryAt: string | null;
  /** Status label from the page (already-localised). */
  status: string;
  /** Order total as displayed, e.g. "234,56 zł". */
  totalText: string;
  /** Numeric total in PLN. */
  totalValue: number | null;
  /** Best-effort URL to the order's detail page if linked. */
  detailUrl: string | null;
}

export interface OrderHistory {
  url: string;
  orders: OrderSummary[];
  /** Free-form notes parsed from page banners. */
  notes: string[];
}

function parsePricePln(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/([\d]+(?:[.,]\d+)?)\s*(?:zł|pln)?/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return isFinite(v) ? v : null;
}

const PL_MONTHS: Record<string, string> = {
  stycznia: '01', stycz: '01', sty: '01',
  lutego: '02', lut: '02',
  marca: '03', mar: '03',
  kwietnia: '04', kwie: '04', kwi: '04',
  maja: '05', maj: '05',
  czerwca: '06', cze: '06',
  lipca: '07', lip: '07',
  sierpnia: '08', sie: '08',
  września: '09', wrz: '09',
  października: '10', paź: '10', paz: '10',
  listopada: '11', lis: '11',
  grudnia: '12', gru: '12',
};

/**
 * Try to coerce common Frisco date strings into ISO YYYY-MM-DD. Frisco
 * mixes formats: "12 marca 2025", "12.03.2025", "2025-03-12", "12 mar".
 * Returns null on unparsable input. Year defaults to the current year if
 * absent (best-effort).
 */
export function parseFriscoDate(raw: string | null | undefined, today: Date = new Date()): string | null {
  if (!raw) return null;
  const txt = raw.trim().toLowerCase();
  if (!txt) return null;

  // ISO already.
  const iso = txt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // "12.03.2025" or "12.03.25"
  const dotted = txt.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (dotted) {
    const dd = dotted[1].padStart(2, '0');
    const mm = dotted[2].padStart(2, '0');
    let yyyy = dotted[3];
    if (yyyy.length === 2) yyyy = `20${yyyy}`;
    return `${yyyy}-${mm}-${dd}`;
  }

  // Strip a trailing wall-clock time ("26 kwietnia 2026 12:37" → "26 kwietnia 2026")
  // so the polish/dotted matchers below can still anchor.
  const noTime = txt.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/, '');

  // "12 marca 2025" / "12 marca"
  const polish = noTime.match(/^(\d{1,2})\s+([\p{L}]+)(?:\s+(\d{4}))?$/u);
  if (polish) {
    const dd = polish[1].padStart(2, '0');
    const monthKey = polish[2];
    const mm = PL_MONTHS[monthKey];
    if (mm) {
      const yyyy = polish[3] ?? String(today.getFullYear());
      return `${yyyy}-${mm}-${dd}`;
    }
  }

  return null;
}

/**
 * Pure normaliser for tests.
 */
export function normaliseOrderHistory(
  url: string,
  raw: Array<{
    orderId: string;
    placedAt: string;
    deliveryAt: string;
    status: string;
    totalText: string;
    detailHref: string | null;
  }>,
  notes: string[] = [],
  today: Date = new Date(),
): OrderHistory {
  return {
    url,
    notes: notes.filter(Boolean).map(n => n.trim()).filter(Boolean),
    orders: raw.map(o => ({
      orderId: o.orderId.trim(),
      placedAt: parseFriscoDate(o.placedAt, today),
      deliveryAt: parseFriscoDate(o.deliveryAt, today),
      status: o.status.trim(),
      totalText: o.totalText.trim(),
      totalValue: parsePricePln(o.totalText),
      detailUrl: o.detailHref
        ? o.detailHref.startsWith('http')
          ? o.detailHref
          : `https://www.frisco.pl${o.detailHref}`
        : null,
    })),
  };
}

export interface OrderQuery {
  /** ISO date inclusive (YYYY-MM-DD); orders placedAt >= this. */
  fromDate?: string;
  /** ISO date inclusive (YYYY-MM-DD); orders placedAt <= this. */
  toDate?: string;
  /** Substring match on status (case-insensitive). */
  status?: string;
  /** Min total in PLN. */
  minTotalPln?: number;
  /** Max items in the result. */
  limit?: number;
}

export function queryOrders(history: OrderHistory, q: OrderQuery): OrderSummary[] {
  let xs = [...history.orders];
  if (q.fromDate) xs = xs.filter(o => o.placedAt != null && o.placedAt >= q.fromDate!);
  if (q.toDate) xs = xs.filter(o => o.placedAt != null && o.placedAt <= q.toDate!);
  if (q.status) {
    const needle = q.status.toLowerCase();
    xs = xs.filter(o => o.status.toLowerCase().includes(needle));
  }
  if (q.minTotalPln != null) {
    const cap = q.minTotalPln;
    xs = xs.filter(o => o.totalValue != null && o.totalValue >= cap);
  }
  if (q.limit != null && q.limit > 0) xs = xs.slice(0, q.limit);
  return xs;
}

/**
 * Aggregate spend over a result set. Useful for "total spent in March"
 * style questions; the model can call get_order_history with a date
 * filter and read the summary line out of the formatted reply.
 */
export function summariseSpend(orders: OrderSummary[]): {
  totalPln: number;
  totalCount: number;
  averagePln: number | null;
} {
  const withTotals = orders.filter(o => o.totalValue != null) as Array<
    OrderSummary & { totalValue: number }
  >;
  const sum = withTotals.reduce((acc, o) => acc + o.totalValue, 0);
  return {
    totalPln: Math.round(sum * 100) / 100,
    totalCount: orders.length,
    averagePln: withTotals.length ? Math.round((sum / withTotals.length) * 100) / 100 : null,
  };
}

export function formatOrderHistory(history: OrderHistory, q?: OrderQuery): string {
  const filtered = q ? queryOrders(history, q) : history.orders;
  if (filtered.length === 0) {
    return [
      '❌ No orders matched.',
      `   Page URL: ${history.url}`,
      q && (q.fromDate || q.toDate || q.status)
        ? '   (filters were applied; broaden them to see more)'
        : '   (your order list appears empty or unparseable; share a screenshot if unexpected)',
    ].filter(Boolean).join('\n');
  }
  const summary = summariseSpend(filtered);
  const out: string[] = [`📋 Order history (${filtered.length} order${filtered.length === 1 ? '' : 's'}):`, ''];
  for (const order of filtered) {
    const datePart = order.placedAt ?? '(date unknown)';
    const totalPart = order.totalText || '(no total)';
    out.push(`📦 ${order.orderId} — ${datePart} — ${order.status} — ${totalPart}`);
    if (order.deliveryAt) out.push(`   delivery: ${order.deliveryAt}`);
    if (order.detailUrl) out.push(`   ${order.detailUrl}`);
  }
  out.push('');
  out.push(
    `Σ ${summary.totalPln.toFixed(2)} zł over ${summary.totalCount} orders` +
    (summary.averagePln != null ? ` (avg ${summary.averagePln.toFixed(2)} zł)` : ''),
  );
  if (history.notes.length) {
    out.push('');
    out.push('Notes:');
    for (const n of history.notes) out.push(`   • ${n}`);
  }
  return out.join('\n');
}

/**
 * Browser-side scrape. Frisco's order-list markup is fairly stable; we
 * still use multi-selector fallbacks so a small markup change doesn't
 * empty the result.
 */
export async function fetchOrderHistory(): Promise<OrderHistory> {
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  if (!page.url().includes('sub,history') && !page.url().includes('user-orders')) {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  }
  await page.waitForTimeout(SETTLE_MS);

  const raw = await page.evaluate(() => {
    function txt(el: Element | null | undefined): string {
      return el ? (el as HTMLElement).innerText.trim() : '';
    }
    function normalize(s: string): string {
      return s.replace(/\s+/g, ' ').trim();
    }

    // Page-not-found detection. Frisco moves URLs occasionally and a
    // stale URL in this tool then silently returns "no orders" — which
    // makes agents trust there are no orders. Fail loudly instead.
    const bodyText = document.body.innerText;
    const pageNotFound = /\bnie\s+znaleźli[a-z]*\s+strony\b/i.test(bodyText);
    if (pageNotFound) {
      return {
        url: window.location.href,
        orders: [],
        notes: [],
        pageNotFound: true,
      };
    }

    // Order-id pattern Frisco uses: "1234567/123456" (numeric/numeric).
    const orderIdPattern = /\b(\d{6,8})\s*\/\s*(\d{6})\b/;

    // Heuristic: any visible block that contains an order-id pattern
    // AND "Wartość zamówienia" (order value) is an order card. Class-
    // name selectors aren't reliable here — Frisco uses CSS-module
    // hashed names that change between deploys. Walk the DOM, find
    // elements that look like an order, then dedup to the deepest
    // match so we don't double-count nested wrappers.
    let cards = Array.from(
      document.querySelectorAll<HTMLElement>('article, section, div, li'),
    ).filter(
      (el) =>
        el.offsetParent !== null &&
        orderIdPattern.test(el.innerText) &&
        /wartość\s+zamówienia/i.test(el.innerText) &&
        el.innerText.length < 4000, // avoid the whole-page wrapper
    );
    // Dedup: keep only the deepest matches (no element that contains
    // another matched element).
    cards = cards.filter(
      (el, _i, arr) => !arr.some((other) => other !== el && el.contains(other)),
    );

    const orders = cards.map((card) => {
      const t = card.innerText;
      const tl = t.toLowerCase();

      const idMatch = orderIdPattern.exec(t);
      const orderId = idMatch ? `${idMatch[1]}/${idMatch[2]}` : '';

      // Date — look for "Data zamówienia\n<DATE>" or first day-month-year.
      const placedMatch =
        /data\s+zamówienia[\s:\n]+([0-3]?\d\s+\p{L}+\s+\d{4}(?:\s+\d{1,2}:\d{2})?)/iu.exec(t) ||
        /([0-3]?\d\s+(?:stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)\s+\d{4})/iu.exec(t);
      const placedAt = placedMatch ? normalize(placedMatch[1]) : '';

      const deliveryMatch =
        /adres\s+i\s+termin\s+dostawy[\s:\n]+([0-3]?\d\s+\p{L}+\s+\d{4}(?:[^\n]*\d{1,2}:\d{2}[^\n]*\d{1,2}:\d{2})?)/iu.exec(t);
      const deliveryAt = deliveryMatch ? normalize(deliveryMatch[1]) : '';

      // Status — common Frisco labels.
      const statusMatch = /\b(zrealizowan[ye]|anulowan[ye]|w realizacji|przyjęt[ye]|gotow[ye] do odbioru|dostarczon[ye])\b/i.exec(tl);
      const status = statusMatch ? statusMatch[1] : '';

      // Total — "Wartość zamówienia\n265,57 zł"
      const totalMatch =
        /wartość\s+zamówienia[\s:\n]+([\d\s]+,\d{2}\s*zł)/i.exec(t) ||
        /(\d[\d\s]*,\d{2}\s*zł)/i.exec(t);
      const totalText = totalMatch ? normalize(totalMatch[1]) : '';

      const a = card.querySelector<HTMLAnchorElement>('a[href*="/order"], a[href*="/zamow"]');
      const detailHref = a ? a.getAttribute('href') : null;

      return { orderId, placedAt, deliveryAt, status, totalText, detailHref };
    });

    const notes = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="banner"], [class*="notice"]'),
    )
      .filter((el) => el.offsetParent !== null)
      .map((el) => txt(el))
      .filter(Boolean);

    return {
      url: window.location.href,
      orders,
      notes,
      pageNotFound: false,
    };
  });

  if (raw.pageNotFound) {
    throw new OrderPageNotFoundError(
      `Order history page returned 'page not found' at ${raw.url}. ` +
        `Frisco may have moved the URL again — please update ORDERS_URL in src/tools/orders.ts. ` +
        `Last known good: /stn,settings/sub,history (this version). Previous: ${LEGACY_ORDERS_URL}.`,
    );
  }
  return normaliseOrderHistory(raw.url, raw.orders, raw.notes);
}

export class OrderPageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderPageNotFoundError";
  }
}

export async function getOrderHistory(query?: OrderQuery): Promise<string> {
  const hist = await fetchOrderHistory();
  return formatOrderHistory(hist, query);
}

// ---------------------------------------------------------------------------
// Order detail (line items)
// ---------------------------------------------------------------------------
//
// Frisco renders past-order detail at /stn,orderCart/orderId,<id> as a
// checkout-shaped page: one `.products-by-category_section` per category,
// each containing newline-delimited product chunks ending with "Usuń"
// (the per-row Remove button label). We parse the text blocks to extract
// brand, name, size, and quantity — that's enough to build a "staples
// checklist" or to compare two orders.
//
// We intentionally do NOT click the Remove buttons or do anything that
// could mutate the historical order. Read-only.

export interface OrderLineItem {
  category: string;
  brand: string;
  name: string;
  size: string | null;
  /** Numeric quantity ordered. null when the line was "chwilowo niedostępny". */
  quantity: number | null;
  /** Sticker price string, e.g. "7,29 zł". */
  priceText: string | null;
  /** Numeric sticker price in PLN. */
  priceValue: number | null;
  /** True if the order line was on promotion. */
  promo: boolean;
  /** True if Frisco flagged the item as currently unavailable. */
  unavailable: boolean;
}

export interface OrderDetail {
  orderId: string;
  url: string;
  items: OrderLineItem[];
  totalText: string | null;
  totalValue: number | null;
  itemCountText: string | null;
}

const ORDER_ID_PATTERN = /^\d{6,8}$/;
const ORDER_DETAIL_BASE = 'https://www.frisco.pl/stn,orderCart/orderId,';

function buildOrderDetailUrl(orderId: string): string {
  // Accept the long form "1640647/260008" — Frisco's URL only takes the
  // back half (the per-account sequence). Strip anything before "/".
  const tail = orderId.includes('/') ? orderId.split('/').pop()! : orderId;
  if (!ORDER_ID_PATTERN.test(tail)) {
    throw new Error(`Invalid order id ${JSON.stringify(orderId)} — expected 6-8 digits, optionally prefixed with "<account>/".`);
  }
  return `${ORDER_DETAIL_BASE}${tail}`;
}

/**
 * Pure parser for the per-section innerText emitted by the order detail
 * page. Exposed for unit tests; used by fetchOrderDetail.
 *
 * Within a section's inner text, products are separated by the line
 * "Usuń". Each chunk has roughly:
 *
 *   [Promocja]            optional promo banner line
 *   BRAND                 first non-empty line
 *   Product name          second line
 *   <size>                "500 g", "1 l", "1 szt", "10 szt." …
 *   <unit price>          "12,78 zł/kg" - sometimes absent
 *   Cena | Cena promocyjna
 *   <price>               "6,39 zł"
 *   [<old price>]         only on promo
 *   [najniższa cena z 30 dni …]
 *   [Produkt chwilowo niedostępny]
 *   <integer quantity>    only when in stock
 *   <line-total>          "0,00 zł" on this view
 *   Usuń                  line terminator
 *   [Przydatny do …]      best-before, may follow Usuń
 */
export function parseOrderDetailSection(
  category: string,
  productsText: string,
): OrderLineItem[] {
  const lines = productsText.split('\n').map(l => l.trim()).filter(Boolean);
  const items: OrderLineItem[] = [];
  let buf: string[] = [];

  const flush = (): void => {
    if (buf.length === 0) return;

    // Drop noise lines that appear AROUND a real item but aren't part
    // of its identity:
    //  - "Przydatny do …" / "Przydatny ok." — best-before info from
    //    the previous item that landed in this chunk.
    //  - "Promocja" — promo banner for THIS item.
    //  - "Aktywuj promocję" / "X zł/szt. kupując N szt." — multi-buy
    //    promo overlay text from before the brand line.
    //  - "friscontowa cena" / "friscowa cena" — Frisco-Today badge.
    let promo = false;
    buf = buf.filter(l => {
      if (/^przydatny\b/i.test(l)) return false;
      if (/^promocja$/i.test(l)) { promo = true; return false; }
      if (/aktywuj\s+promocj/i.test(l)) { promo = true; return false; }
      if (/kupując\s+\d+\s*szt/i.test(l)) { promo = true; return false; }
      if (/frisco\w*\s*cena/i.test(l)) { promo = true; return false; }
      return true;
    });

    if (buf.length < 2) {
      buf = [];
      return;
    }

    const brand = buf[0];
    const name = buf[1];

    const sizeRe = /^\d+[\d.,]*\s*(g|kg|ml|l|szt|szt\.)\b/i;
    const size = buf.find(l => sizeRe.test(l)) ?? null;

    const unavailable = buf.some(l => /chwilowo\s+niedostępny/i.test(l));
    if (/cena\s+promocyjna/i.test(buf.join(' '))) promo = true;

    let quantity: number | null = null;
    if (!unavailable) {
      // The quantity line is a bare positive integer that appears AFTER
      // the price block. Walk lines from the end backwards, skipping the
      // line-total ("0,00 zł") and "Usuń"; the first standalone
      // positive integer is the quantity.
      for (let i = buf.length - 1; i >= 0; i--) {
        const l = buf[i];
        if (/^\d+$/.test(l)) {
          const n = parseInt(l, 10);
          if (n > 0 && n < 1000) {
            quantity = n;
            break;
          }
        }
      }
    }

    // Sticker price: first "X,YY zł" that is not "0,00 zł" (line total)
    // and not the unit price ("X,YY zł/kg"). Capture the leftmost match.
    let priceText: string | null = null;
    for (const l of buf) {
      const m = /^(\d[\d\s]*,\d{2})\s*zł$/.exec(l);
      if (m && m[1].replace(/\s/g, '') !== '0,00') {
        priceText = `${m[1].trim()} zł`;
        break;
      }
    }
    const priceValue = parsePricePln(priceText);

    items.push({
      category,
      brand,
      name,
      size,
      quantity,
      priceText,
      priceValue,
      promo,
      unavailable,
    });

    buf = [];
  };

  for (const line of lines) {
    if (line === 'Usuń') {
      flush();
      continue;
    }
    buf.push(line);
  }
  // Trailing chunk shouldn't happen (all real items end with Usuń) but
  // flush defensively.
  flush();

  return items;
}

export async function fetchOrderDetail(orderId: string): Promise<OrderDetail> {
  const url = buildOrderDetailUrl(orderId);
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await page.waitForTimeout(SETTLE_MS);

  const raw = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    if (/\bnie\s+znaleźli[a-z]*\s+strony\b/i.test(bodyText)) {
      return { url: window.location.href, sections: [], totalText: null, itemCountText: null, pageNotFound: true };
    }
    if (/\bzaloguj\b/i.test(bodyText) && !/wyloguj/i.test(bodyText)) {
      return { url: window.location.href, sections: [], totalText: null, itemCountText: null, pageNotFound: true };
    }

    const sections = Array.from(
      document.querySelectorAll<HTMLElement>('.products-by-category_section'),
    ).map(section => {
      const headerEl = section.querySelector<HTMLElement>('.products-by-category_section-category-header');
      const productsEl = section.querySelector<HTMLElement>('.products-by-category_section-category-products');
      const headerText = headerEl?.innerText?.trim() ?? '';
      // Header is "Category\nN produkty"; take first line.
      const category = headerText.split('\n')[0]?.trim() ?? 'Inne';
      const productsText = productsEl?.innerText ?? '';
      return { category, productsText };
    });

    // Total + item count from the order summary block at the bottom.
    let totalText: string | null = null;
    let itemCountText: string | null = null;
    // "Do zapłaty\n267,13 zł"
    const totalMatch = /do\s+zapłaty[\s\n]+([\d\s]+,\d{2}\s*zł)/i.exec(bodyText);
    if (totalMatch) totalText = totalMatch[1].replace(/\s+/g, ' ').trim();
    // "Koszyk (18 produktów)"
    const countMatch = /koszyk\s*\(\s*(\d+)\s+produkt[óa-z]*\)/i.exec(bodyText);
    if (countMatch) itemCountText = countMatch[1];

    return { url: window.location.href, sections, totalText, itemCountText, pageNotFound: false };
  });

  if (raw.pageNotFound) {
    throw new OrderPageNotFoundError(
      `Order detail page not found at ${raw.url}. Either the order id is wrong, ` +
        `the order doesn't belong to this account, or Frisco moved /stn,orderCart again.`,
    );
  }

  const items: OrderLineItem[] = [];
  for (const s of raw.sections) {
    items.push(...parseOrderDetailSection(s.category, s.productsText));
  }

  return {
    orderId,
    url: raw.url,
    items,
    totalText: raw.totalText,
    totalValue: parsePricePln(raw.totalText),
    itemCountText: raw.itemCountText,
  };
}

export function formatOrderDetail(detail: OrderDetail): string {
  if (detail.items.length === 0) {
    return [
      `❌ No line items parsed for order ${detail.orderId}.`,
      `   Page URL: ${detail.url}`,
      `   This usually means the page rendered but the parser missed the markup —`,
      `   share a screenshot if the order is real.`,
    ].join('\n');
  }
  const out: string[] = [
    `📦 Order ${detail.orderId} — ${detail.items.length} line${detail.items.length === 1 ? '' : 's'}` +
      (detail.itemCountText ? ` (${detail.itemCountText} products on receipt)` : '') +
      (detail.totalText ? ` — ${detail.totalText}` : ''),
    '',
  ];
  // Group by category for readability.
  const byCat = new Map<string, OrderLineItem[]>();
  for (const item of detail.items) {
    const arr = byCat.get(item.category) ?? [];
    arr.push(item);
    byCat.set(item.category, arr);
  }
  for (const [cat, arr] of byCat) {
    out.push(`▸ ${cat}`);
    for (const it of arr) {
      const qtyPart = it.unavailable
        ? '(unavailable)'
        : it.quantity != null
          ? `×${it.quantity}`
          : '×?';
      const sizePart = it.size ? ` — ${it.size}` : '';
      const pricePart = it.priceText ? ` — ${it.priceText}${it.promo ? ' (promo)' : ''}` : '';
      out.push(`   • ${qtyPart} ${it.brand} ${it.name}${sizePart}${pricePart}`);
    }
  }
  return out.join('\n');
}

export async function getOrderDetails(orderId: string): Promise<string> {
  const detail = await fetchOrderDetail(orderId);
  return formatOrderDetail(detail);
}
