/**
 * The only thing in a run that is allowed to vary (EXPD-015).
 *
 * A fake team is not a script. It gets some answers right and some wrong, it
 * takes longer on one mission than on another, and sometimes it gives up. All
 * of that has to come from somewhere, and if it came from `Math.random` the
 * harness would be useless for the three jobs it has: a test that passes four
 * times out of five is not a test, a duration estimate nobody can reproduce
 * is not an estimate, and the AI builder cannot tell an author their
 * expedition is broken if the same expedition passes on the next run.
 *
 * So the harness carries its own generator, seeded from a string. The same
 * seed and the same expedition give the same run, line for line, on any
 * machine — which is the same promise the engine itself makes and for the
 * same reason.
 *
 * The generator is mulberry32, written out here rather than taken from
 * anywhere, because the engine has no dependencies and is not allowed to grow
 * one. It is not a cryptographic generator and does not need to be: nothing
 * here keeps a secret, and what is wanted is a cheap, well-mixed, exactly
 * reproducible sequence.
 */

/** A source of the small decisions a fake team makes. */
export interface Random {
  /** The next number, from 0 up to but not including 1. */
  next(): number;
  /** A whole number from `min` to `max`, both ends included. */
  between(min: number, max: number): number;
  /** True this often, from 0 (never) to 1 (always). */
  chance(probability: number): boolean;
  /** One of the items, or `undefined` when there are none. */
  pick<TItem>(items: readonly TItem[]): TItem | undefined;
}

/**
 * Turns a seed string into the number the generator starts from.
 *
 * FNV-1a, 32 bit. Any string works, so a caller can seed a run with the
 * expedition's own id and get a run that is stable for that expedition.
 */
export function seedNumber(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A generator that starts from the given seed.
 *
 * Each generator carries its own state, so two of them made from the same
 * seed run in step and one team's luck can never depend on how many
 * decisions another team happened to make first.
 */
export function createRandom(seed: string): Random {
  let state = seedNumber(seed);

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };

  return {
    next,
    between(min: number, max: number): number {
      const low = Math.ceil(Math.min(min, max));
      const high = Math.floor(Math.max(min, max));
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) {
        return low;
      }
      return low + Math.floor(next() * (high - low + 1));
    },
    chance(probability: number): boolean {
      // A probability outside nought-to-one is a dial somebody turned too
      // far, not a reason to throw in the middle of a run.
      if (probability <= 0) {
        return false;
      }
      if (probability >= 1) {
        return true;
      }
      return next() < probability;
    },
    pick<TItem>(items: readonly TItem[]): TItem | undefined {
      if (items.length === 0) {
        return undefined;
      }
      return items[Math.floor(next() * items.length)];
    },
  };
}

/**
 * A figure spread either side of the one asked for, by the fraction given.
 *
 * What stops every team taking exactly the same number of seconds over every
 * mission. `spread` of 0.25 means anything from three quarters of `seconds`
 * to a quarter more. Never negative, and always a whole number of seconds,
 * because the clock the harness keeps counts in whole seconds.
 */
export function jitter(random: Random, seconds: number, spread: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  const width = Math.max(0, Math.min(1, spread));
  const factor = 1 - width + random.next() * width * 2;
  return Math.max(0, Math.round(seconds * factor));
}
