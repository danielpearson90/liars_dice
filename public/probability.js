// Binomial probability helper, shared by the client UI and unit tests.
//
// In Liar's Dice with no wilds, each unknown die independently shows a given
// face with probability 1/6. The chance a bid of `quantity` is true over `n`
// unknown dice is P(X >= quantity) for X ~ Binomial(n, 1/6).

/**
 * P(X >= k) where X ~ Binomial(n, p).
 * @param {number} k successes needed (the bid quantity)
 * @param {number} n number of dice considered
 * @param {number} [p] per-die success probability (default 1/6)
 * @returns {number} probability in [0, 1]
 */
export function pAtLeast(k, n, p = 1 / 6) {
  if (k <= 0) return 1; // any outcome already satisfies "at least 0"
  if (k > n) return 0; // can't get more successes than dice
  // Walk the pmf from i=0 upward using the ratio recurrence, which avoids
  // computing large binomial coefficients directly:
  //   pmf(0)   = (1 - p)^n
  //   pmf(i)   = pmf(i-1) * ((n - i + 1) / i) * (p / (1 - p))
  const ratio = p / (1 - p);
  let pmf = Math.pow(1 - p, n);
  let cumulativeBelow = pmf; // sum of pmf(0..i)
  for (let i = 1; i < k; i++) {
    pmf *= ((n - i + 1) / i) * ratio;
    cumulativeBelow += pmf;
  }
  // P(X >= k) = 1 - P(X <= k-1). Clamp to guard against tiny FP drift.
  return Math.min(1, Math.max(0, 1 - cumulativeBelow));
}
