// Delivery-window inspection tool.
//
// Frisco's "wybierz dostawę" (choose delivery) flow lets the user pick
// from a calendar of date columns; each column lists hourly time slots
// with prices and an availability badge. We surface that grid as a
// JSON-friendly structure so the model can reason about "cheapest
// morning slot Friday" or "earliest available evening" without doing
// its own DOM scrape.
//
// Implementation note: the Frisco delivery page has gone through several
// markup variants. We use multiple selector fallbacks and a generous
// settle wait. If parsing finds zero days the tool reports a recoverable
// error with the page URL — the user can then take a screenshot or
// adjust the selectors.

import { getPage, getContext } from '../browser.js';
import { ensureLoggedIn } from '../auth.js';

// Frisco moved the delivery-slot picker from /stn,checkout-delivery →
// /stn,checkout (step 2 of the unified checkout flow) sometime before
// 2026-04-29. The legacy URL silently 404s.
const DELIVERY_URL = 'https://www.frisco.pl/stn,checkout';
const NAV_TIMEOUT_MS = 25_000;
const SETTLE_MS = 2_500;

export interface DeliverySlot {
  /** Hour range as it appears on the page, e.g. "07:00 – 09:00". */
  time: string;
  /** Slot price as displayed, e.g. "9,99 zł" or "0,00 zł". */
  price: string;
  /** Numeric price in PLN parsed from `price` (null if unparsable). */
  priceValue: number | null;
  /** "available" — pickable; "unavailable" — full/disabled. */
  status: 'available' | 'unavailable';
  /** Lowercase tag (eco/express/etc.) extracted from the slot card if any. */
  tag?: string;
}

export interface DeliveryDay {
  /** ISO-ish display date e.g. "2025-04-29" or, when only the visible label
   *  is parseable, "Wt 29.04". Always set; never empty. */
  date: string;
  /** Polish day-of-week label as shown ("Pon", "Wt", …) when present. */
  dayLabel: string;
  /** The slot grid. */
  slots: DeliverySlot[];
}

export interface DeliveryGrid {
  url: string;
  days: DeliveryDay[];
  /** Free-form notes parsed from page banners (e.g. fuel-surcharge note). */
  notes: string[];
}

function parsePricePln(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(/([\d]+(?:[.,]\d+)?)\s*(?:zł|pln)?/i);
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  return isFinite(v) ? v : null;
}

/**
 * Pure parser exposed for tests: given the JSON shape produced by the
 * in-page evaluator, normalise it into DeliveryGrid (price values etc.).
 */
export interface RawDay {
  date: string;
  dayLabel: string;
  slots: Array<{
    time: string;
    price: string;
    status: 'available' | 'unavailable';
    tag?: string;
  }>;
}

export function normaliseDeliveryGrid(
  url: string,
  raw: RawDay[],
  notes: string[],
): DeliveryGrid {
  return {
    url,
    notes: notes.filter(Boolean).map(n => n.replace(/\s+/g, ' ').trim()).filter(Boolean),
    days: raw.map(day => ({
      date: day.date.trim(),
      dayLabel: day.dayLabel.trim(),
      slots: day.slots.map(slot => ({
        time: slot.time.trim(),
        price: slot.price.trim(),
        priceValue: parsePricePln(slot.price),
        status: slot.status,
        tag: slot.tag ? slot.tag.toLowerCase().trim() : undefined,
      })),
    })),
  };
}

/**
 * Filter a DeliveryGrid by basic predicates. Used both internally
 * (for find_cheapest / find_earliest) and exposed as part of the tool
 * input schema.
 */
export interface SlotQuery {
  preferTimeOfDay?: 'morning' | 'afternoon' | 'evening';
  maxPricePln?: number;
  onlyAvailable?: boolean;
  limit?: number;
}

const TIME_OF_DAY_BUCKETS: Record<NonNullable<SlotQuery['preferTimeOfDay']>, [number, number]> = {
  morning: [5, 12],
  afternoon: [12, 18],
  evening: [18, 23],
};

function slotStartHour(time: string): number | null {
  const m = time.match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  return isFinite(h) ? h : null;
}

export function flattenSlots(grid: DeliveryGrid): Array<{
  day: DeliveryDay;
  slot: DeliverySlot;
}> {
  const out: Array<{ day: DeliveryDay; slot: DeliverySlot }> = [];
  for (const day of grid.days) for (const slot of day.slots) out.push({ day, slot });
  return out;
}

export function querySlots(
  grid: DeliveryGrid,
  q: SlotQuery,
): Array<{ day: DeliveryDay; slot: DeliverySlot }> {
  let pairs = flattenSlots(grid);

  if (q.onlyAvailable !== false) {
    pairs = pairs.filter(p => p.slot.status === 'available');
  }

  if (q.maxPricePln != null) {
    const cap = q.maxPricePln;
    pairs = pairs.filter(p => p.slot.priceValue != null && p.slot.priceValue <= cap);
  }

  if (q.preferTimeOfDay) {
    const [from, to] = TIME_OF_DAY_BUCKETS[q.preferTimeOfDay];
    pairs = pairs.filter(p => {
      const h = slotStartHour(p.slot.time);
      return h != null && h >= from && h < to;
    });
  }

  if (q.limit != null && q.limit > 0) {
    pairs = pairs.slice(0, q.limit);
  }
  return pairs;
}

export function findCheapestSlot(
  grid: DeliveryGrid,
  q: Omit<SlotQuery, 'limit'> = {},
): { day: DeliveryDay; slot: DeliverySlot } | null {
  const pairs = querySlots(grid, { ...q, onlyAvailable: q.onlyAvailable ?? true });
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => {
    const ap = a.slot.priceValue ?? Number.POSITIVE_INFINITY;
    const bp = b.slot.priceValue ?? Number.POSITIVE_INFINITY;
    if (ap !== bp) return ap - bp;
    // tie-break: earlier day first, then earlier hour.
    if (a.day.date !== b.day.date) return a.day.date.localeCompare(b.day.date);
    return (slotStartHour(a.slot.time) ?? 99) - (slotStartHour(b.slot.time) ?? 99);
  })[0];
}

export function findEarliestSlot(
  grid: DeliveryGrid,
  q: Omit<SlotQuery, 'limit'> = {},
): { day: DeliveryDay; slot: DeliverySlot } | null {
  const pairs = querySlots(grid, { ...q, onlyAvailable: q.onlyAvailable ?? true });
  if (!pairs.length) return null;
  return [...pairs].sort((a, b) => {
    if (a.day.date !== b.day.date) return a.day.date.localeCompare(b.day.date);
    return (slotStartHour(a.slot.time) ?? 99) - (slotStartHour(b.slot.time) ?? 99);
  })[0];
}

/**
 * Run the in-browser scrape and return the normalised grid.
 *
 * We accept that the selectors here are the most fragile part of the
 * fork: Frisco's checkout markup changes more often than the search
 * page. The JS uses several fallbacks per element (date column, time
 * cell, price, status badge) so a small markup shift survives.
 */
export async function fetchDeliveryGrid(): Promise<DeliveryGrid> {
  const page = await getPage();
  const context = await getContext();
  await ensureLoggedIn(page, context);

  if (!page.url().includes('checkout')) {
    await page.goto(DELIVERY_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  }
  await page.waitForTimeout(SETTLE_MS);

  const raw = await page.evaluate(() => {
    function txt(el: Element | null | undefined): string {
      return el ? (el as HTMLElement).innerText.trim() : '';
    }

    const dayCols = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="delivery-day"], [class*="day-column"], [data-test*="day"]',
      ),
    ).filter(el => el.offsetParent !== null);

    const days: Array<{
      date: string;
      dayLabel: string;
      slots: Array<{
        time: string;
        price: string;
        status: 'available' | 'unavailable';
        tag?: string;
      }>;
    }> = [];

    for (const col of dayCols) {
      const dateText =
        txt(col.querySelector('[class*="date"]')) ||
        txt(col.querySelector('[data-test*="date"]')) ||
        '';
      const dayLabel =
        txt(col.querySelector('[class*="day-label"], [class*="weekday"]')) || '';

      const slotEls = Array.from(
        col.querySelectorAll<HTMLElement>(
          '[class*="time-slot"], [class*="hour-slot"], button[class*="slot"], [data-test*="slot"]',
        ),
      );

      const slots = slotEls.map(slot => {
        const time =
          txt(slot.querySelector('[class*="time"], [class*="hour"]')) ||
          txt(slot);
        const price = txt(slot.querySelector('[class*="price"], [class*="cost"]')) || '';
        const disabled =
          slot.classList.contains('disabled') ||
          slot.classList.contains('unavailable') ||
          slot.hasAttribute('disabled') ||
          (slot.getAttribute('aria-disabled') ?? '') === 'true';
        const tag = txt(slot.querySelector('[class*="tag"], [class*="badge"]')) || '';
        return {
          time,
          price,
          status: (disabled ? 'unavailable' : 'available') as 'available' | 'unavailable',
          tag: tag || undefined,
        };
      });

      if (dateText || dayLabel || slots.length) {
        days.push({ date: dateText, dayLabel, slots });
      }
    }

    const notes = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[class*="notice"], [class*="banner"], [class*="info-box"]',
      ),
    )
      .filter(el => el.offsetParent !== null)
      .map(el => txt(el))
      .filter(Boolean);

    return { days, notes, url: window.location.href };
  });

  return normaliseDeliveryGrid(raw.url, raw.days, raw.notes);
}

export function formatGrid(grid: DeliveryGrid, opts: { maxSlotsPerDay?: number } = {}): string {
  const cap = opts.maxSlotsPerDay ?? 6;
  if (grid.days.length === 0) {
    return [
      '❌ No delivery days were parsed from the page.',
      `   Page URL: ${grid.url}`,
      '   The Frisco markup may have changed; please share a screenshot.',
    ].join('\n');
  }

  const out: string[] = [`📦 Delivery slots (${grid.url}):`, ''];
  for (const day of grid.days) {
    const header = day.dayLabel ? `${day.dayLabel} ${day.date}`.trim() : day.date;
    out.push(`📅 ${header}`);
    if (day.slots.length === 0) {
      out.push('   (no slots listed)');
    } else {
      for (const slot of day.slots.slice(0, cap)) {
        const marker = slot.status === 'available' ? '✅' : '⛔';
        const tagPart = slot.tag ? ` [${slot.tag}]` : '';
        out.push(`   ${marker} ${slot.time}  ${slot.price}${tagPart}`);
      }
      if (day.slots.length > cap) {
        out.push(`   …and ${day.slots.length - cap} more`);
      }
    }
    out.push('');
  }
  if (grid.notes.length) {
    out.push('Notes:');
    for (const n of grid.notes) out.push(`   • ${n}`);
  }
  return out.join('\n').trimEnd();
}

export async function getDeliverySlots(query?: SlotQuery): Promise<string> {
  const grid = await fetchDeliveryGrid();
  if (!query || (!query.preferTimeOfDay && query.maxPricePln == null && !query.limit)) {
    return formatGrid(grid);
  }
  const filtered = querySlots(grid, query);
  if (filtered.length === 0) {
    return [
      `❌ No slots match the filter (preferTimeOfDay=${query.preferTimeOfDay ?? 'any'}, maxPricePln=${query.maxPricePln ?? 'any'}).`,
      `   Page URL: ${grid.url}`,
    ].join('\n');
  }
  const lines = [`🔎 Matching delivery slots:`, ''];
  for (const { day, slot } of filtered) {
    const marker = slot.status === 'available' ? '✅' : '⛔';
    const tagPart = slot.tag ? ` [${slot.tag}]` : '';
    const dateHeader = day.dayLabel ? `${day.dayLabel} ${day.date}` : day.date;
    lines.push(`${marker} ${dateHeader} • ${slot.time} • ${slot.price}${tagPart}`);
  }
  lines.push('');
  lines.push(`🔗 ${grid.url}`);
  return lines.join('\n');
}
