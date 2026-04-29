import { describe, it, expect } from 'vitest';
import { withPageLock } from '../browser.js';

// withPageLock provides FIFO mutex semantics around the singleton
// browser/page. Without it, parallel tool callers race on the same Page
// object and earlier callers see DOM written by the last navigate. These
// tests pin the contract using fake async work; the real browser bug
// the lock fixes is also covered by a live concurrent-search probe.

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('withPageLock', () => {
  it('runs sections sequentially even when invoked in parallel', async () => {
    const trace: string[] = [];
    await Promise.all([
      withPageLock(async () => {
        trace.push('A:start');
        await delay(20);
        trace.push('A:end');
      }),
      withPageLock(async () => {
        trace.push('B:start');
        await delay(10);
        trace.push('B:end');
      }),
      withPageLock(async () => {
        trace.push('C:start');
        await delay(5);
        trace.push('C:end');
      }),
    ]);
    expect(trace).toEqual([
      'A:start',
      'A:end',
      'B:start',
      'B:end',
      'C:start',
      'C:end',
    ]);
  });

  it('releases the lock after a thrown exception', async () => {
    let secondRan = false;
    await expect(
      withPageLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await withPageLock(async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
  });

  it('returns the inner function value through the lock', async () => {
    const result = await withPageLock(async () => 42);
    expect(result).toBe(42);
  });

  it('does not deadlock when re-entered from after-the-await', async () => {
    // A naive single-promise lock would deadlock if called inside another
    // critical section. We don't support that here — just confirm the
    // happy path of long-then-short doesn't deadlock either.
    const start = Date.now();
    await withPageLock(async () => {
      await delay(20);
    });
    await withPageLock(async () => {
      await delay(5);
    });
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('FIFO ordering: 10 racing acquirers run in submit order', async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 10 }, (_, i) =>
      withPageLock(async () => {
        order.push(i);
        await delay(2);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
