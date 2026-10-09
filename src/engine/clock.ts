export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export class ManualClock implements Clock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  nowMs(): number {
    return this.current;
  }

  advance(byMs: number): void {
    this.current += byMs;
  }

  set(toMs: number): void {
    this.current = toMs;
  }
}
