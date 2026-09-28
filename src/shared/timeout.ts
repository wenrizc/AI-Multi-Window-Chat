/**
 * Layered network timeouts.
 *
 * A single `fetch` call only accepts one `AbortSignal`, so this module builds a
 * combined signal from the caller's user-abort signal plus an internal
 * controller. The internal controller is aborted by resettable timers:
 *
 *   - first byte: from request start until `fetch` resolves (connect + headers)
 *   - idle:       between consecutive chunks; must cover the `reader.read()`
 *                 wait, so it is reset via `touch()` after every chunk
 *   - total:      hard upper bound for the whole request
 *
 * Aborting with a `TimeoutError` reason keeps automated retries safe: the
 * provider can tell a timeout apart from a user pressing "Stop".
 */

export interface TimeoutBudget {
  /** Max time from request start until the response headers arrive. */
  firstByteMs: number;
  /** Max gap between consecutive streamed chunks. `null` disables idle checks. */
  idleMs: number | null;
  /** Hard upper bound for the whole request. `null` disables it. */
  totalMs: number | null;
}

export const STREAM_TIMEOUTS: TimeoutBudget = {
  firstByteMs: 20_000,
  idleMs: 30_000,
  totalMs: 600_000
};

export const COMPLETE_TIMEOUTS: TimeoutBudget = {
  firstByteMs: 20_000,
  idleMs: null,
  totalMs: 180_000
};

export const CONNECT_TIMEOUTS: TimeoutBudget = {
  firstByteMs: 15_000,
  idleMs: null,
  totalMs: 20_000
};

export const DEFAULT_STREAM_TIMEOUT = STREAM_TIMEOUTS;
export const DEFAULT_COMPLETE_TIMEOUT = COMPLETE_TIMEOUTS;
export const DEFAULT_TEST_TIMEOUT = CONNECT_TIMEOUTS;

export type TimeoutKind = 'first_byte' | 'idle' | 'total';

export function timeoutMessage(kind: TimeoutKind | null): string {
  switch (kind) {
    case 'first_byte':
      return 'The provider did not start responding in time.';
    case 'idle':
      return 'The response stream stalled.';
    case 'total':
      return 'The request exceeded its time budget.';
    default:
      return 'The request timed out.';
  }
}

function createTimeoutError(kind: TimeoutKind): DOMException {
  return new DOMException(timeoutMessage(kind), 'TimeoutError');
}

export class RequestGuard {
  /** Combined signal: aborts on user cancel OR on any timeout. */
  readonly signal: AbortSignal;
  timedOut = false;
  timeoutKind: TimeoutKind | null = null;

  private readonly controller = new AbortController();
  private readonly budget: TimeoutBudget;
  private readonly userSignal: AbortSignal | undefined;
  private readonly relayUserAbort: () => void;
  private firstByteTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private totalTimer: ReturnType<typeof setTimeout> | null = null;
  private firstByteSeen = false;
  private cleaned = false;

  constructor(options: { budget: TimeoutBudget; userSignal?: AbortSignal }) {
    this.budget = options.budget;
    this.userSignal = options.userSignal;
    this.relayUserAbort = () => {
      if (!this.controller.signal.aborted) {
        this.controller.abort(
          this.userSignal?.reason ?? new DOMException('Aborted', 'AbortError')
        );
      }
    };

    if (options.userSignal) {
      if (options.userSignal.aborted) {
        this.relayUserAbort();
      } else {
        options.userSignal.addEventListener('abort', this.relayUserAbort, { once: true });
      }
    }

    this.signal = this.controller.signal;
    this.startFirstByteTimer();
    this.startTotalTimer();
  }

  /** Call once the response headers have been received. */
  markFirstByte(): void {
    if (this.cleaned || this.firstByteSeen) {
      return;
    }
    this.firstByteSeen = true;
    this.clearTimer('firstByteTimer');
    this.startIdleTimer();
  }

  /** Call after every received chunk to reset the idle timer. */
  touch(): void {
    if (this.cleaned || !this.firstByteSeen) {
      return;
    }
    this.startIdleTimer();
  }

  cleanup(): void {
    this.cleaned = true;
    this.clearTimer('firstByteTimer');
    this.clearTimer('idleTimer');
    this.clearTimer('totalTimer');
    if (this.userSignal) {
      this.userSignal.removeEventListener('abort', this.relayUserAbort);
    }
  }

  /** Human-readable reason for the most recent timeout. */
  timeoutMessage(): string {
    return timeoutMessage(this.timeoutKind);
  }

  private startFirstByteTimer(): void {
    if (this.budget.firstByteMs <= 0) {
      return;
    }
    this.firstByteTimer = setTimeout(() => this.fire('first_byte'), this.budget.firstByteMs);
  }

  private startIdleTimer(): void {
    this.clearTimer('idleTimer');
    const idleMs = this.budget.idleMs;
    if (idleMs === null || idleMs <= 0) {
      return;
    }
    this.idleTimer = setTimeout(() => this.fire('idle'), idleMs);
  }

  private startTotalTimer(): void {
    const totalMs = this.budget.totalMs;
    if (totalMs === null || totalMs <= 0) {
      return;
    }
    this.totalTimer = setTimeout(() => this.fire('total'), totalMs);
  }

  private fire(kind: TimeoutKind): void {
    if (this.cleaned || this.timedOut) {
      return;
    }
    this.timedOut = true;
    this.timeoutKind = kind;
    if (!this.controller.signal.aborted) {
      this.controller.abort(createTimeoutError(kind));
    }
  }

  private clearTimer(name: 'firstByteTimer' | 'idleTimer' | 'totalTimer'): void {
    const timer = this[name];
    if (timer !== null) {
      clearTimeout(timer);
      this[name] = null;
    }
  }
}
