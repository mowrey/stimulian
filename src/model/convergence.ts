// Convergence phase (N -> 1) and recursive refinement of the spark-expansion-
// convergence-propagation cycle.
//
// Source: A. Mowrey, "From Spark to Swarm: A Branching-Process Model of Idea
// Evolution in Capability-Weighted Node Ecosystems", Stimuli.Network working
// paper, November 2026. Definitions 3 and 5, Assumption 1, Propositions 3-4,
// Corollary 1, Section 5.1 and Experiments 2-3 (Table 2, Section 5.4).
//
// An initiator holding an idea I (a vector in R^d) collects N responses r_i from
// nodes of capability c_i > 0, scores each with a validation score v_i in [0, 1],
// and absorbs only the responses that pass the gate v_i >= theta:
//
//   I_1 = I_0 + alpha * sum_i w_i v_i 1[v_i >= theta] r_i,   w_i = c_i / sum_j c_j.
//
// Iterating the step with a fresh active set each round is the refinement loop
// (eq. 5). The threshold theta trades bias against variance (Proposition 3) and
// the absorption rate alpha has a stability bound (Proposition 4).

import { mulberry32 } from "./cascade.ts";

export type Vec = readonly number[];

/** One node's contribution to a convergence step. */
export interface Contribution {
  /** Capability c_i > 0. */
  capability: number;
  /** Validation score v_i in [0, 1] assigned by the initiator. */
  validation: number;
  /** The proposed change r_i, a vector of the same dimension as the idea. */
  response: Vec;
}

export interface GateParams {
  /** Absorption rate alpha > 0. */
  alpha: number;
  /** Validation threshold theta in [0, 1]. */
  theta: number;
}

function checkFinite(x: number, name: string): void {
  if (!Number.isFinite(x)) throw new RangeError(`${name} must be a finite number, got ${x}`);
}

function checkGate({ alpha, theta }: GateParams): void {
  if (!(Number.isFinite(alpha) && alpha > 0)) throw new RangeError(`alpha must be a finite number > 0, got ${alpha}`);
  if (!(theta >= 0 && theta <= 1)) throw new RangeError(`theta must be in [0, 1], got ${theta}`);
}

function checkVec(v: Vec, d: number, name: string): void {
  if (!Array.isArray(v) || v.length !== d) throw new RangeError(`${name} must be a vector of dimension ${d}, got ${Array.isArray(v) ? v.length : typeof v}`);
  for (const x of v) checkFinite(x, `${name} entries`);
}

function checkScores(capabilities: readonly number[], validations: readonly number[]): void {
  if (capabilities.length === 0) throw new RangeError("at least one contribution is required");
  if (capabilities.length !== validations.length) throw new RangeError("capabilities and validations must have the same length");
  for (const c of capabilities) if (!(Number.isFinite(c) && c > 0)) throw new RangeError(`capability must be a finite number > 0, got ${c}`);
  for (const v of validations) if (!(v >= 0 && v <= 1)) throw new RangeError(`validation score must be in [0, 1], got ${v}`);
}

export function norm(v: Vec): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function sub(a: Vec, b: Vec): number[] {
  return a.map((x, i) => x - b[i]);
}

/** Capability weights w_i = c_i / sum_j c_j (Definition 3). Normalised over all N nodes, so they do not depend on theta. */
export function capabilityWeights(capabilities: readonly number[]): number[] {
  checkScores(capabilities, capabilities.map(() => 0));
  const total = capabilities.reduce((s, c) => s + c, 0);
  return capabilities.map((c) => c / total);
}

/** Effective weights a_i(theta) = w_i v_i 1[v_i >= theta] (Definition 3). */
export function effectiveWeights(capabilities: readonly number[], validations: readonly number[], theta: number): number[] {
  checkScores(capabilities, validations);
  if (!(theta >= 0 && theta <= 1)) throw new RangeError(`theta must be in [0, 1], got ${theta}`);
  const w = capabilityWeights(capabilities);
  return w.map((wi, i) => (validations[i] >= theta ? wi * validations[i] : 0));
}

/** Total accepted gain G(theta) = sum_i a_i(theta), always in [0, 1]. Non-increasing in theta (Proposition 3(i)). */
export function acceptedGain(capabilities: readonly number[], validations: readonly number[], theta: number): number {
  return effectiveWeights(capabilities, validations, theta).reduce((s, a) => s + a, 0);
}

export interface ConvergenceResult {
  /** The refined idea I_1. */
  next: number[];
  /** The absorbed update I_1 - I_0. */
  update: number[];
  /** Whether each response passed the gate. */
  accepted: boolean[];
  /** Capability weights w_i. */
  weights: number[];
  /** Effective weights a_i(theta). */
  effective: number[];
  /** G(theta). */
  gain: number;
}

/** Equation (2): one gated, capability-weighted convergence step. */
export function convergeStep(idea: Vec, contributions: readonly Contribution[], p: GateParams): ConvergenceResult {
  checkGate(p);
  if (!Array.isArray(idea) || idea.length === 0) throw new RangeError("idea must be a non-empty vector");
  checkVec(idea, idea.length, "idea");
  const caps = contributions.map((c) => c.capability);
  const vals = contributions.map((c) => c.validation);
  checkScores(caps, vals);
  contributions.forEach((c, i) => checkVec(c.response, idea.length, `response ${i}`));
  const weights = capabilityWeights(caps);
  const effective = effectiveWeights(caps, vals, p.theta);
  const update = new Array<number>(idea.length).fill(0);
  effective.forEach((a, i) => {
    if (a === 0) return;
    const r = contributions[i].response;
    for (let k = 0; k < update.length; k++) update[k] += p.alpha * a * r[k];
  });
  return {
    next: idea.map((x, k) => x + update[k]),
    update,
    accepted: vals.map((v) => v >= p.theta),
    weights,
    effective,
    gain: effective.reduce((s, a) => s + a, 0),
  };
}

/** A response under Assumption 1: r_i = s_i + eps_i with E eps_i = 0 and Cov eps_i = sigma_i^2 I_d. */
export interface ResponseModel {
  capability: number;
  validation: number;
  /** Deterministic signal s_i. */
  signal: Vec;
  /** Per-coordinate noise standard deviation sigma_i >= 0. */
  sigma: number;
}

export interface StepMoments {
  /** E[Delta | c, v] = alpha * sum_i a_i s_i. */
  mean: number[];
  /** tr Cov(Delta | c, v) = alpha^2 d sum_i a_i^2 sigma_i^2. */
  traceCov: number;
  /** Bias E[Delta] - g against the ideal update g, when given. */
  bias?: number[];
  /** Squared bias norm plus trace of the covariance: E||Delta - g||^2. */
  mse?: number;
}

/** Proposition 3: conditional mean and total variance of the update Delta(theta), and its bias and MSE against an ideal update g. */
export function stepMoments(models: readonly ResponseModel[], p: GateParams, ideal?: Vec): StepMoments {
  checkGate(p);
  if (models.length === 0) throw new RangeError("at least one response model is required");
  const d = models[0].signal.length;
  if (d === 0) throw new RangeError("signal must be a non-empty vector");
  models.forEach((m, i) => {
    checkVec(m.signal, d, `signal ${i}`);
    if (!(Number.isFinite(m.sigma) && m.sigma >= 0)) throw new RangeError(`sigma must be a finite number >= 0, got ${m.sigma}`);
  });
  const a = effectiveWeights(models.map((m) => m.capability), models.map((m) => m.validation), p.theta);
  const mean = new Array<number>(d).fill(0);
  let varSum = 0;
  a.forEach((ai, i) => {
    for (let k = 0; k < d; k++) mean[k] += p.alpha * ai * models[i].signal[k];
    varSum += ai * ai * models[i].sigma ** 2;
  });
  const traceCov = p.alpha ** 2 * d * varSum;
  if (!ideal) return { mean, traceCov };
  checkVec(ideal, d, "ideal update");
  const bias = sub(mean, ideal);
  return { mean, traceCov, bias, mse: norm(bias) ** 2 + traceCov };
}

/** Proposition 4(ii): effective gain lambda = alpha * sum_i a_i kappa_i for contractive responses f_i = kappa_i (I* - I) + e_i. */
export function effectiveGain(effective: readonly number[], kappas: readonly number[], alpha: number): number {
  if (effective.length !== kappas.length) throw new RangeError("effective weights and kappas must have the same length");
  if (!(Number.isFinite(alpha) && alpha > 0)) throw new RangeError(`alpha must be a finite number > 0, got ${alpha}`);
  for (const k of kappas) if (!(Number.isFinite(k) && k >= 0)) throw new RangeError(`kappa must be a finite number >= 0, got ${k}`);
  return alpha * effective.reduce((s, a, i) => s + a * kappas[i], 0);
}

/** Proposition 4(ii): contraction factor rho = max(|1 - lambda_-|, |1 - lambda_+|). Below 1 iff [lambda_-, lambda_+] lies in (0, 2). */
export function contractionFactor(lambdaMin: number, lambdaMax: number = lambdaMin): number {
  checkFinite(lambdaMin, "lambdaMin");
  checkFinite(lambdaMax, "lambdaMax");
  if (lambdaMin > lambdaMax) throw new RangeError(`lambdaMin must not exceed lambdaMax, got ${lambdaMin} > ${lambdaMax}`);
  return Math.max(Math.abs(1 - lambdaMin), Math.abs(1 - lambdaMax));
}

/** Proposition 4(ii): sufficient stability condition alpha < 2 / kappa_max. Returns the bound 2 / kappa_max. */
export function stableAlphaBound(kappaMax: number): number {
  if (!(Number.isFinite(kappaMax) && kappaMax > 0)) throw new RangeError(`kappaMax must be a finite number > 0, got ${kappaMax}`);
  return 2 / kappaMax;
}

/** Proposition 4(ii): ||I_t - I*|| <= rho^t ||I_0 - I*|| + alpha eps / (1 - rho), valid when rho < 1. */
export function errorBound(t: number, rho: number, initialError: number, alpha: number, epsilon: number): number {
  if (!Number.isInteger(t) || t < 0) throw new RangeError(`t must be a non-negative integer, got ${t}`);
  if (!(rho >= 0 && rho < 1)) throw new RangeError(`rho must be in [0, 1) for the bound to hold, got ${rho}`);
  if (!(initialError >= 0) || !(epsilon >= 0) || !(alpha > 0)) throw new RangeError("initialError and epsilon must be >= 0 and alpha > 0");
  return rho ** t * initialError + (alpha * epsilon) / (1 - rho);
}

/** One round's inputs to the refinement loop: the active set's responses to the current idea. */
export type Responder = (idea: Vec, round: number) => readonly Contribution[];

export interface RefineOptions {
  /** Absorption rate: a constant, or a schedule alpha_t (Corollary 1). */
  alpha: number | ((round: number) => number);
  theta: number;
  rounds: number;
  /** Optional target I*; when given the result records ||I_t - I*|| per round. */
  target?: Vec;
}

export interface RefineResult {
  /** I_0, I_1, ..., I_rounds. */
  trajectory: number[][];
  /** ||I_t - I*|| for t = 0..rounds, when a target was given. */
  errors?: number[];
  /** G(theta) in each round. */
  gains: number[];
}

/** Equation (5): repeat the convergence step for `rounds` rounds with a round-dependent active set supplied by `respond`. */
export function refine(initial: Vec, respond: Responder, opts: RefineOptions): RefineResult {
  if (!Number.isInteger(opts.rounds) || opts.rounds < 0) throw new RangeError(`rounds must be a non-negative integer, got ${opts.rounds}`);
  if (opts.target) checkVec(opts.target, initial.length, "target");
  const trajectory: number[][] = [[...initial]];
  const gains: number[] = [];
  let idea: number[] = [...initial];
  for (let t = 0; t < opts.rounds; t++) {
    const alpha = typeof opts.alpha === "function" ? opts.alpha(t) : opts.alpha;
    const step = convergeStep(idea, respond(idea, t), { alpha, theta: opts.theta });
    idea = step.next;
    trajectory.push(idea);
    gains.push(step.gain);
  }
  const res: RefineResult = { trajectory, gains };
  if (opts.target) res.errors = trajectory.map((x) => norm(sub(x, opts.target!)));
  return res;
}

// ---------------------------------------------------------------------------
// Synthetic setup of Section 5.1. The paper's own script (simulate.py) is not
// published with the text, so the decoy is reconstructed from its description:
// a misaligned node returns 0.5 ||g|| u plus the same Gaussian noise as an
// aligned node, where u is a unit decoy direction shared by all misaligned nodes
// in one replication (or one recursion run).

/** Seeded standard normal sampler (Box-Muller on mulberry32). */
export function gaussian(seed: number): () => number {
  const u = mulberry32(seed);
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) { const s = spare; spare = undefined; return s; }
    let a = 0;
    while (a <= Number.EPSILON) a = u();
    const b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
}

export interface SyntheticSetup {
  /** Dimension d. Paper: 10. */
  dim: number;
  /** Probability that a node is misaligned. Paper: 0.3. */
  misalignedRate: number;
  /** Capability range, Uniform(lo, hi). Paper: (0.1, 1). */
  capabilityRange: [number, number];
  /** Standard deviation of the validation noise xi. Paper: 0.1. */
  validationNoise: number;
  /** Decoy magnitude as a multiple of ||g||. Paper: about 0.5. */
  decoyScale: number;
}

export const PAPER_SETUP: Readonly<SyntheticSetup> = Object.freeze({
  dim: 10,
  misalignedRate: 0.3,
  capabilityRange: [0.1, 1] as [number, number],
  validationNoise: 0.1,
  decoyScale: 0.5,
});

interface Node { capability: number; misaligned: boolean }

function unitVector(rand: () => number, d: number): number[] {
  const v = Array.from({ length: d }, rand);
  const n = norm(v);
  return v.map((x) => x / n);
}

function drawNode(u: () => number, s: SyntheticSetup): Node {
  const [lo, hi] = s.capabilityRange;
  return { capability: lo + (hi - lo) * u(), misaligned: u() < s.misalignedRate };
}

function respond(node: Node, g: Vec, decoy: Vec, z: () => number, s: SyntheticSetup): Contribution {
  const gn = norm(g);
  const sd = (0.6 * (1.2 - node.capability) * gn + 0.05) / Math.sqrt(s.dim);
  const base = node.misaligned ? decoy.map((x) => s.decoyScale * gn * x) : g.map((x) => node.capability * x);
  const r = base.map((x) => x + sd * z());
  const rn = norm(r);
  const cos = gn > 0 && rn > 0 ? r.reduce((acc, x, k) => acc + x * g[k], 0) / (rn * gn) : 0;
  const v = Math.min(1, Math.max(0, (1 + cos) / 2 + s.validationNoise * z()));
  return { capability: node.capability, validation: v, response: r };
}

function checkSetup(s: SyntheticSetup): void {
  if (!Number.isInteger(s.dim) || s.dim < 1) throw new RangeError(`dim must be a positive integer, got ${s.dim}`);
  if (!(s.misalignedRate >= 0 && s.misalignedRate <= 1)) throw new RangeError(`misalignedRate must be in [0, 1], got ${s.misalignedRate}`);
  const [lo, hi] = s.capabilityRange;
  if (!(lo > 0 && hi >= lo && Number.isFinite(hi))) throw new RangeError(`capabilityRange must satisfy 0 < lo <= hi, got [${lo}, ${hi}]`);
  if (!(s.validationNoise >= 0)) throw new RangeError(`validationNoise must be >= 0, got ${s.validationNoise}`);
  if (!(s.decoyScale >= 0)) throw new RangeError(`decoyScale must be >= 0, got ${s.decoyScale}`);
}

function checkCount(x: number, name: string, min = 1): void {
  if (!Number.isInteger(x) || x < min) throw new RangeError(`${name} must be an integer >= ${min}, got ${x}`);
}

export interface GateSweepOptions {
  /** Number of responding nodes N. */
  N: number;
  alpha: number;
  thetas: readonly number[];
  replications: number;
  seed?: number;
  setup?: Partial<SyntheticSetup>;
}

export interface GateSweepPoint {
  theta: number;
  /** ||E I_1 - I*||^2. */
  bias2: number;
  /** tr Cov(I_1). */
  variance: number;
  /** E ||I_1 - I*||^2 = bias2 + variance. */
  mse: number;
  /** Mean fraction of responses passing the gate. */
  acceptedFraction: number;
}

/**
 * Experiment 2: one convergence step from I_0 = 0 towards a random unit target I*,
 * swept over theta with common random numbers (each replication draws one set of
 * nodes and responses and evaluates every theta on it). The target and the decoy
 * direction are fixed for the whole sweep, so bias is measured against one I*.
 */
export function simulateGateSweep(o: GateSweepOptions): GateSweepPoint[] {
  const s: SyntheticSetup = { ...PAPER_SETUP, ...o.setup };
  checkSetup(s);
  checkCount(o.N, "N");
  checkCount(o.replications, "replications", 2);
  if (o.thetas.length === 0) throw new RangeError("thetas must not be empty");
  for (const theta of o.thetas) checkGate({ alpha: o.alpha, theta });
  const seed = o.seed ?? 1;
  const u = mulberry32(seed);
  const z = gaussian(seed ^ 0x9e3779b9);
  const target = unitVector(z, s.dim);
  const decoy = unitVector(z, s.dim);
  const g = target; // I_0 = 0
  const T = o.thetas.length;
  const sum = Array.from({ length: T }, () => new Array<number>(s.dim).fill(0));
  const sumSq = new Array<number>(T).fill(0);
  const acc = new Array<number>(T).fill(0);
  for (let rep = 0; rep < o.replications; rep++) {
    const contribs = Array.from({ length: o.N }, () => respond(drawNode(u, s), g, decoy, z, s));
    o.thetas.forEach((theta, ti) => {
      const step = convergeStep(new Array(s.dim).fill(0), contribs, { alpha: o.alpha, theta });
      for (let k = 0; k < s.dim; k++) {
        sum[ti][k] += step.next[k];
        sumSq[ti] += step.next[k] ** 2;
      }
      acc[ti] += step.accepted.filter(Boolean).length / o.N;
    });
  }
  const R = o.replications;
  return o.thetas.map((theta, ti) => {
    const mean = sum[ti].map((x) => x / R);
    const bias2 = norm(sub(mean, target)) ** 2;
    const variance = sumSq[ti] / R - norm(mean) ** 2;
    return { theta, bias2, variance, mse: bias2 + variance, acceptedFraction: acc[ti] / R };
  });
}

export interface RefinementSimOptions {
  alpha: number;
  theta: number;
  rounds: number;
  runs: number;
  /** Fixed node pool size M. Paper: 200. */
  pool?: number;
  /** Active nodes per round N. Paper: 20. */
  active?: number;
  /** Errors are capped here, as in the paper. Default 1e6. */
  cap?: number;
  seed?: number;
  setup?: Partial<SyntheticSetup>;
}

export interface RefinementSimResult {
  /** Median ||I_t - I*|| over runs for t = 0..rounds (capped). */
  medianError: number[];
  /** First round at which the median error reached the cap, if it did. */
  capRound?: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Experiment 3: the recursion (5) from I_0 = 0 to a random unit target, with a
 * fresh random subset of `active` nodes drawn each round from a fixed pool of
 * `pool` nodes (fixed capabilities and alignment for the run).
 */
export function simulateRefinement(o: RefinementSimOptions): RefinementSimResult {
  const s: SyntheticSetup = { ...PAPER_SETUP, ...o.setup };
  checkSetup(s);
  checkGate(o);
  checkCount(o.rounds, "rounds", 0);
  checkCount(o.runs, "runs");
  const M = o.pool ?? 200;
  const N = o.active ?? 20;
  checkCount(M, "pool");
  checkCount(N, "active");
  if (N > M) throw new RangeError(`active (${N}) must not exceed pool (${M})`);
  const cap = o.cap ?? 1e6;
  const seed = o.seed ?? 1;
  const u = mulberry32(seed);
  const z = gaussian(seed ^ 0x9e3779b9);
  const errs: number[][] = Array.from({ length: o.rounds + 1 }, () => []);
  for (let run = 0; run < o.runs; run++) {
    const target = unitVector(z, s.dim);
    const decoy = unitVector(z, s.dim);
    const pool = Array.from({ length: M }, () => drawNode(u, s));
    const idx = pool.map((_, i) => i);
    let idea = new Array<number>(s.dim).fill(0);
    let capped = false;
    errs[0].push(Math.min(cap, norm(sub(idea, target))));
    for (let t = 0; t < o.rounds; t++) {
      if (!capped) {
        // Partial Fisher-Yates: the first N entries of idx become this round's active set.
        for (let i = 0; i < N; i++) { const j = i + Math.floor(u() * (M - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        const g = sub(target, idea);
        const contribs = idx.slice(0, N).map((i) => respond(pool[i], g, decoy, z, s));
        idea = convergeStep(idea, contribs, o).next;
        if (!(norm(sub(idea, target)) < cap)) capped = true;
      }
      errs[t + 1].push(capped ? cap : norm(sub(idea, target)));
    }
  }
  const medianError = errs.map(median);
  const capRound = medianError.findIndex((e) => e >= cap);
  return capRound >= 0 ? { medianError, capRound } : { medianError };
}

export interface GainEstimate { mean: number; p05: number; p95: number }

/**
 * Section 5.4: distribution of the effective gain per unit alpha, lambda / alpha =
 * sum_i a_i kappa_i, over aligned nodes (kappa_i = c_i for an aligned node, 0 for a
 * misaligned one) at threshold theta, across `draws` independent active sets of N nodes.
 */
export function estimateGainPerAlpha(o: { theta: number; draws: number; N?: number; seed?: number; setup?: Partial<SyntheticSetup> }): GainEstimate {
  const s: SyntheticSetup = { ...PAPER_SETUP, ...o.setup };
  checkSetup(s);
  checkGate({ alpha: 1, theta: o.theta });
  checkCount(o.draws, "draws");
  const N = o.N ?? 20;
  checkCount(N, "N");
  const seed = o.seed ?? 1;
  const u = mulberry32(seed);
  const z = gaussian(seed ^ 0x9e3779b9);
  const samples: number[] = [];
  for (let d = 0; d < o.draws; d++) {
    const target = unitVector(z, s.dim);
    const decoy = unitVector(z, s.dim);
    const nodes = Array.from({ length: N }, () => drawNode(u, s));
    const contribs = nodes.map((n) => respond(n, target, decoy, z, s));
    const a = effectiveWeights(contribs.map((c) => c.capability), contribs.map((c) => c.validation), o.theta);
    samples.push(effectiveGain(a, nodes.map((n) => (n.misaligned ? 0 : n.capability)), 1));
  }
  samples.sort((x, y) => x - y);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  return { mean: samples.reduce((a, b) => a + b, 0) / samples.length, p05: q(0.05), p95: q(0.95) };
}
