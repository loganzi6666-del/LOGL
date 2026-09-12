/**
 * Seeded, serialisable random number generator.
 *
 * Every roll the engine makes comes from here so that a saved game replays
 * identically: the LLM chooses what nations *try* to do, but the dice that decide
 * how it turns out are reproducible from the save file alone.
 */

/** Hash an arbitrary string into a 32-bit seed. */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1) {
    this.state = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  }

  /** mulberry32 — small, fast, and good enough for gameplay dice. */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max] inclusive. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }

  /** Roughly normal, mean 1, used to jitter combat and economic outcomes. */
  variance(spread = 0.25) {
    const sum = this.next() + this.next() + this.next();
    return 1 + ((sum / 3) * 2 - 1) * spread;
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /** Fisher-Yates, in place. */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  toJSON() {
    return this.state;
  }

  static fromJSON(state) {
    const rng = new Rng(1);
    rng.state = state >>> 0 || 1;
    return rng;
  }
}

/**
 * A generator derived from a parent seed plus a label. Lets one subsystem draw
 * numbers without shifting every other subsystem's sequence, which keeps saves
 * stable when unrelated code changes.
 */
export function subRng(seed, label) {
  return new Rng(hashSeed(`${seed}:${label}`));
}
