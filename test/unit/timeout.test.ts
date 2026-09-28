import { describe, expect, it } from 'vitest';
import {
  RequestGuard,
  timeoutMessage,
  type TimeoutBudget
} from '../../src/shared/timeout';

function waitForAbort(signal: AbortSignal, timeout = 1000): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(() => resolve(), timeout);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const budget = (overrides: Partial<TimeoutBudget>): TimeoutBudget => ({
  firstByteMs: 1000,
  idleMs: null,
  totalMs: null,
  ...overrides
});

describe('RequestGuard', () => {
  it('aborts when the first byte never arrives', async () => {
    const guard = new RequestGuard({ budget: budget({ firstByteMs: 10 }) });
    await waitForAbort(guard.signal);

    expect(guard.timedOut).toBe(true);
    expect(guard.timeoutKind).toBe('first_byte');
    expect(guard.signal.aborted).toBe(true);
    guard.cleanup();
  });

  it('switches from first-byte to idle tracking after markFirstByte', async () => {
    const guard = new RequestGuard({ budget: budget({ firstByteMs: 5000, idleMs: 10 }) });
    guard.markFirstByte();
    expect(guard.signal.aborted).toBe(false);

    await waitForAbort(guard.signal);
    expect(guard.timeoutKind).toBe('idle');
    guard.cleanup();
  });

  it('resets the idle timer on touch', async () => {
    const guard = new RequestGuard({ budget: budget({ idleMs: 40 }) });
    guard.markFirstByte();

    for (let i = 0; i < 4; i += 1) {
      await delay(15);
      guard.touch();
    }
    expect(guard.signal.aborted).toBe(false);

    await waitForAbort(guard.signal);
    expect(guard.timeoutKind).toBe('idle');
    guard.cleanup();
  });

  it('enforces the total budget', async () => {
    const guard = new RequestGuard({ budget: budget({ firstByteMs: 5000, totalMs: 10 }) });
    await waitForAbort(guard.signal);

    expect(guard.timeoutKind).toBe('total');
    guard.cleanup();
  });

  it('relays a user abort without marking a timeout', async () => {
    const controller = new AbortController();
    const guard = new RequestGuard({ budget: budget({}), userSignal: controller.signal });

    controller.abort();
    await waitForAbort(guard.signal);

    expect(guard.signal.aborted).toBe(true);
    expect(guard.timedOut).toBe(false);
    guard.cleanup();
  });

  it('stops firing timers after cleanup', async () => {
    const guard = new RequestGuard({ budget: budget({ firstByteMs: 10 }) });
    guard.cleanup();
    await delay(30);

    expect(guard.signal.aborted).toBe(false);
    expect(guard.timedOut).toBe(false);
  });
});

describe('timeoutMessage', () => {
  it('describes every timeout kind', () => {
    expect(timeoutMessage('first_byte')).toMatch(/start responding/);
    expect(timeoutMessage('idle')).toMatch(/stalled/);
    expect(timeoutMessage('total')).toMatch(/budget/);
    expect(timeoutMessage(null)).toMatch(/timed out/);
  });
});
