/**
 * BadaBhai Design System — toast auto-dismiss clock (#2583).
 *
 * Pure timing, no React and no DOM, so the rule is unit-testable on its own: every toast leaves
 * {@link TOAST_DURATION_MS} after it arrives, and that clock STOPS while the payer is reading —
 * the pointer is over the toast stack or focus is inside it — and resumes with the time that was
 * left, never a fresh 5 seconds and never a toast that vanished mid-read.
 */

/** How long a toast stays before it dismisses itself. */
export const TOAST_DURATION_MS = 5000;

interface Clock {
  /** When the running timer fires (ms since epoch); 0 while paused. */
  due: number;
  /** Time left when paused. */
  remaining: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class ToastTimers {
  private readonly clocks = new Map<number, Clock>();
  private paused = false;

  constructor(
    private readonly onExpire: (id: number) => void,
    private readonly durationMs: number = TOAST_DURATION_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Start the clock for a toast that has just arrived (held at full time while paused). */
  add(id: number): void {
    this.remove(id);
    const clock: Clock = { due: 0, remaining: this.durationMs, timer: undefined };
    this.clocks.set(id, clock);
    if (!this.paused) this.run(id, clock);
  }

  /** Forget a toast (dismissed by hand, or expired). */
  remove(id: number): void {
    const clock = this.clocks.get(id);
    if (clock?.timer !== undefined) clearTimeout(clock.timer);
    this.clocks.delete(id);
  }

  /** Stop every clock, keeping what each had left. Idempotent. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    for (const clock of this.clocks.values()) {
      if (clock.timer !== undefined) clearTimeout(clock.timer);
      clock.timer = undefined;
      clock.remaining = Math.max(0, clock.due - this.now());
    }
  }

  /** Restart every clock with the time it had left. Idempotent. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const [id, clock] of this.clocks) this.run(id, clock);
  }

  /** Clear everything (the provider unmounting). */
  dispose(): void {
    for (const id of this.clocks.keys()) this.remove(id);
  }

  private run(id: number, clock: Clock): void {
    clock.due = this.now() + clock.remaining;
    clock.timer = setTimeout(() => {
      this.clocks.delete(id);
      this.onExpire(id);
    }, clock.remaining);
  }
}
