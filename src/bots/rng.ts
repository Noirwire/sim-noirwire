/**
 * A small, deterministic PRNG (mulberry32) so bot behaviour and tests that
 * exercise it are reproducible from a seed, with no dependency on Math.random.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  nextBool(): boolean {
    return this.next() < 0.5;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(0, items.length - 1)]!;
  }
}
