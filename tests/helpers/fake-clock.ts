/**
 * Fake clock for code with an injectable `now()` and `sleep(ms)`: time moves only when
 * the test calls `advance`, and every `sleep` is recorded.
 */
export class FakeClock {
  current: number;
  /** Every duration passed to `sleep`, in call order. */
  readonly sleeps: number[] = [];
  private timers: { at: number; resolve: () => void }[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now = (): number => this.current;

  sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    return new Promise((resolve) => this.timers.push({ at: this.current + ms, resolve }));
  };

  /** Sleepers not yet woken. */
  get pendingSleeps(): number {
    return this.timers.length;
  }

  /** Moves time forward, waking the due sleepers in order and letting their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      await flush();
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.resolve();
    }
    this.current = target;
    await flush();
  }
}

/** Lets pending promise continuations run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
