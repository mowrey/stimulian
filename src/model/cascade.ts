// Propagation phase (1 -> n) of the spark-expansion-convergence-propagation cycle.
//
// Source: A. Mowrey, "From Spark to Swarm: A Branching-Process Model of Idea
// Evolution in Capability-Weighted Node Ecosystems", Stimuli.Network working
// paper, November 2026. Definition 4, Propositions 1-2, Remark 1, Table 1.
//
// An idea (a milestone result, a referral, a published tool) is emitted to n
// peers per hop, and each hop keeps a fraction delta of its value. The product
// m = n * delta decides whether delivered value fades (m < 1), grows linearly
// (m = 1) or compounds (m > 1). Read stochastically, each recipient forwards to
// each of its n peers with probability delta, which is a Galton-Watson process
// with Binomial(n, delta) offspring.

export type Regime = "fading" | "steady" | "compounding";

export interface CascadeParams {
  /** Fan-out per hop, an integer >= 2 (the paper's n). */
  n: number;
  /** Per-hop fidelity in (0, 1) (the paper's delta). */
  delta: number;
}

const EPS = 1e-12;

function check({ n, delta }: CascadeParams): void {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`n must be an integer >= 2, got ${n}`);
  if (!(delta > 0 && delta < 1)) throw new RangeError(`delta must be in (0, 1), got ${delta}`);
}

function checkHops(k: number): void {
  if (!Number.isInteger(k) || k < 0) throw new RangeError(`k must be a non-negative integer, got ${k}`);
}

/** Geometric sum 1 + x + ... + x^k (proof of Proposition 1). */
function geometricSum(x: number, k: number): number {
  return Math.abs(x - 1) < EPS ? k + 1 : (x ** (k + 1) - 1) / (x - 1);
}

/** The critical quantity m = n * delta, the mean offspring of the cascade. */
export function criticalQuantity(p: CascadeParams): number {
  check(p);
  return p.n * p.delta;
}

/** Proposition 2: which side of the threshold n * delta = 1 the cascade sits on. */
export function regime(p: CascadeParams): Regime {
  const m = criticalQuantity(p);
  if (Math.abs(m - 1) < EPS) return "steady";
  return m < 1 ? "fading" : "compounding";
}

/** Equation (3) / Proposition 1: cumulative reach R_k = sum_{j=0..k} n^j at full fidelity. */
export function reach(n: number, k: number): number {
  if (!Number.isInteger(n) || n < 2) throw new RangeError(`n must be an integer >= 2, got ${n}`);
  checkHops(k);
  return geometricSum(n, k);
}

/** Equation (4) / Proposition 1: cumulative delivered value V_k = vBar * sum_{j=0..k} (n delta)^j. */
export function cumulativeValue(p: CascadeParams, k: number, vBar = 1): number {
  checkHops(k);
  return vBar * geometricSum(criticalQuantity(p), k);
}

/** Proposition 2(i): V_inf = vBar / (1 - n delta) when n delta < 1, otherwise Infinity. */
export function limitValue(p: CascadeParams, vBar = 1): number {
  const m = criticalQuantity(p);
  return m < 1 - EPS ? vBar / (1 - m) : Infinity;
}

/** Remark 1: dV_inf / d delta = n vBar / (1 - n delta)^2, the payoff of better fidelity near the threshold. */
export function limitValueSensitivity(p: CascadeParams, vBar = 1): number {
  const m = criticalQuantity(p);
  return m < 1 - EPS ? (p.n * vBar) / (1 - m) ** 2 : Infinity;
}

/** Offspring probability generating function phi(s) = (1 - delta + delta s)^n. */
export function offspringPgf(p: CascadeParams, s: number): number {
  check(p);
  return (1 - p.delta + p.delta * s) ** p.n;
}

/**
 * Proposition 2: extinction probability q, the smallest root of q = (1 - delta + delta q)^n
 * on [0, 1]. Equal to 1 iff n delta <= 1. Found by iterating phi from 0, which increases
 * monotonically to the smallest fixed point.
 */
export function extinctionProbability(p: CascadeParams, tol = 1e-13, maxIter = 1_000_000): number {
  if (criticalQuantity(p) <= 1 + EPS) return 1;
  let q = 0;
  for (let i = 0; i < maxIter; i++) {
    const next = offspringPgf(p, q);
    if (Math.abs(next - q) < tol) return next;
    q = next;
  }
  return q;
}

/** Exact Pr(Z_k = 0): the cascade has died out by hop k. Equals phi applied k times to 0. */
export function extinctionByHop(p: CascadeParams, k: number): number {
  checkHops(k);
  let q = 0;
  for (let i = 0; i < k; i++) q = offspringPgf(p, q);
  return q;
}

/** Asymptotic survival probability 1 - q of the cascade. */
export function survivalProbability(p: CascadeParams): number {
  return 1 - extinctionProbability(p);
}

/** Offspring variance sigma^2 = n delta (1 - delta) of Binomial(n, delta). */
export function offspringVariance(p: CascadeParams): number {
  check(p);
  return p.n * p.delta * (1 - p.delta);
}

/** Remark 1: at criticality Pr(Z_k > 0) ~ 2 / (sigma^2 k), a large-k estimate. */
export function criticalSurvivalEstimate(p: CascadeParams, k: number): number {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`);
  return 2 / (offspringVariance(p) * k);
}

/** Deterministic PRNG (mulberry32) so simulations are reproducible from a seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulationOptions {
  /** Hops after the source (the paper's k). */
  hops: number;
  /** Monte Carlo runs. */
  runs: number;
  seed?: number;
  /** Stop a run that grows past this many active nodes; it is counted as surviving. Default 1e6. */
  cap?: number;
}

export interface SimulationResult {
  /** Mean of sum_{j=0..k} Z_j over runs, an estimate of V_k / vBar. */
  meanCumulative: number;
  /** Fraction of runs with Z_j = 0 for some j <= hops ("extinct within hops + 1 generations"). */
  extinctFraction: number;
  /** Fraction of runs with Z_hops > 0. */
  survivalFraction: number;
}

/**
 * Monte Carlo of the Galton-Watson cascade of Proposition 2: start with Z_0 = 1,
 * each active node forwards to each of its n peers independently with probability delta.
 * Runs that pass `cap` active nodes are extrapolated with the mean (n delta)^j for the
 * remaining hops, which keeps the estimator unbiased for meanCumulative.
 */
export function simulateCascade(p: CascadeParams, opts: SimulationOptions): SimulationResult {
  check(p);
  checkHops(opts.hops);
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new RangeError(`runs must be a positive integer, got ${opts.runs}`);
  const rand = mulberry32(opts.seed ?? 1);
  const cap = opts.cap ?? 1_000_000;
  const m = p.n * p.delta;
  let total = 0;
  let extinct = 0;
  let alive = 0;
  for (let r = 0; r < opts.runs; r++) {
    let z = 1;
    let sum = 1;
    let j = 0;
    for (; j < opts.hops && z > 0 && z <= cap; j++) {
      let next = 0;
      for (let i = 0, trials = z * p.n; i < trials; i++) if (rand() < p.delta) next++;
      z = next;
      sum += z;
    }
    if (z > cap) {
      // Expected remaining contribution given Z_j = z: z * sum_{i=1..hops-j} m^i.
      const rest = opts.hops - j;
      sum += z * (geometricSum(m, rest) - 1);
      alive++;
    } else if (z === 0) extinct++;
    else alive++;
    total += sum;
  }
  return { meanCumulative: total / opts.runs, extinctFraction: extinct / opts.runs, survivalFraction: alive / opts.runs };
}

export interface CascadeReport {
  n: number;
  delta: number;
  criticalQuantity: number;
  regime: Regime;
  hops: number;
  reach: number;
  cumulativeValue: number;
  limitValue: number;
  survivalProbability: number;
}

/** One-call summary used by the `stimulian cascade` command. */
export function cascadeReport(p: CascadeParams, hops: number, vBar = 1): CascadeReport {
  return {
    n: p.n,
    delta: p.delta,
    criticalQuantity: criticalQuantity(p),
    regime: regime(p),
    hops,
    reach: reach(p.n, hops),
    cumulativeValue: cumulativeValue(p, hops, vBar),
    limitValue: limitValue(p, vBar),
    survivalProbability: survivalProbability(p),
  };
}
