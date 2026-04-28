// Orders / order-history tool.
//
// Reads the user's past orders from /stn,user-orders. Frisco shows them
// as a list of cards with order ID, placed-at date, status, total, and
// a delivery date. We surface that as a JSON-friendly structure so the
// model can answer "when was my last order", "what did I get last
// Tuesday", "spent how much in March".
//
// We do NOT click into individual orders for line-item detail in this
// pass — Frisco's order-detail page is gated by an extra confirmation
// step on some accounts. Listing-level data is enough for "find by
// date" and "spend summary" questions, which is the user's stated need.

import { getPage, getContext } from '../browser.js';
import { ensureLoggedIn } from '../auth.js';

const ORDERS_URL = 'https://www.frisco.pl/stn,user-orders';
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

  // "12 marca 2025" / "12 marca"
  const polish = txt.match(/^(\d{1,2})\s+([\p{L}]+)(?:\s+(\d{4}))?$/u);
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

  if (!page.url().includes('user-orders')) {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  }
  await page.waitForTimeout(SETTLE_MS);

  const raw = await page.evaluate(() => {
    function txt(el: Element | null | undefined): string {
      return el ? (el as HTMLElement).innerText.trim() : '';
    }

    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="order-row"], [class*="order-card"], [data-test*="order"]',
      ),
    ).filter(el => el.offsetParent !== null);

    const orders = cards.map(card => {
      const orderId =
        txt(card.querySelector('[class*="order-id"], [class*="order-number"]')) ||
        txt(card.querySelector('[data-test*="id"]')) ||
        '';
      const placedAt =
        txt(card.querySelector('[class*="placed"], [class*="created"]')) ||
        txt(card.querySelector('[data-test*="placed-at"]')) ||
        '';
      const deliveryAt =
        txt(card.querySelector('[class*="delivery-date"], [class*="delivery"]')) || '';
      const status =
        txt(card.querySelector('[class*="status"], [class*="state"]')) || '';
      const totalText =
        txt(card.querySelector('[class*="total"], [class*="sum"]')) || '';
      const a = card.querySelector<HTMLAnchorElement>('a[href*="/order"]');
      const detailHref = a ? a.getAttribute('href') : null;
      return { orderId, placedAt, deliveryAt, status, totalText, detailHref };
    });

    const notes = Array.from(
      document.querySelectorAll<HTMLElement>('[class*="banner"], [class*="notice"]'),
    )
      .filter(el => el.offsetParent !== null)
      .map(el => txt(el))
      .filter(Boolean);

    return { url: window.location.href, orders, notes };
  });

  return normaliseOrderHistory(raw.url, raw.orders, raw.notes);
}

export async function getOrderHistory(query?: OrderQuery): Promise<string> {
  const hist = await fetchOrderHistory();
  return formatOrderHistory(hist, query);
}
