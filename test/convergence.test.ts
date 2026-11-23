import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../src/model/cascade.ts";
import {
  acceptedGain,
  capabilityWeights,
  contractionFactor,
  convergeStep,
  effectiveGain,
  effectiveWeights,
  errorBound,
  estimateGainPerAlpha,
  gaussian,
  norm,
  refine,
  simulateGateSweep,
  simulateRefinement,
  stableAlphaBound,
  stepMoments,
  type Contribution,
  type ResponseModel,
} from "../src/model/convergence.ts";

// Numbers below come from A. Mowrey, "From Spark to Swarm" (Stimuli.Network working
// paper, November 2026): Definition 3, Propositions 3-4, Table 2 and Section 5.4.
const close = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected} +/- ${tol}, got ${actual}`);
const rel = (actual: number, expected: number, frac: number, msg?: string) => close(actual, expected, frac * Math.abs(expected), msg);
const SEEDS = [1, 2, 3];

function randomModels(seed: number, N: number, d: number): ResponseModel[] {
  const u = mulberry32(seed);
  const z = gaussian(seed + 100);
  return Array.from({ length: N }, () => ({
    capability: 0.1 + 0.9 * u(),
    validation: u(),
    signal: Array.from({ length: d }, z),
    sigma: u(),
  }));
}

test("Definition 3: capability weights are c_i / sum c_j", () => {
  assert.deepEqual(capabilityWeights([1, 3]), [0.25, 0.75]);
  const w = capabilityWeights([0.2, 0.5, 0.3, 1]);
  close(w.reduce((a, b) => a + b, 0), 1, 1e-15);
  close(w[3] / w[0], 5, 1e-12);
});

test("Equation (2): a hand-computed convergence step", () => {
  const contributions: Contribution[] = [
    { capability: 1, validation: 0.9, response: [1, 0] },
    { capability: 2, validation: 0.5, response: [0, 1] },
    { capability: 1, validation: 0.3, response: [-1, -1] }, // gated out at theta = 0.4
  ];
  const step = convergeStep([1, 1], contributions, { alpha: 2, theta: 0.4 });
  assert.deepEqual(step.weights, [0.25, 0.5, 0.25]);
  assert.deepEqual(step.accepted, [true, true, false]);
  assert.deepEqual(step.effective, [0.225, 0.25, 0]);
  close(step.gain, 0.475, 1e-15);
  close(step.update[0], 0.45, 1e-15);
  close(step.update[1], 0.5, 1e-15);
  close(step.next[0], 1.45, 1e-15);
  close(step.next[1], 1.5, 1e-15);
  // The gate is inclusive: v_i >= theta.
  assert.deepEqual(convergeStep([0, 0], contributions, { alpha: 1, theta: 0.5 }).accepted, [true, true, false]);
  // theta = 0 absorbs everything; G(0) = sum w_i v_i.
  close(acceptedGain([1, 2, 1], [0.9, 0.5, 0.3], 0), 0.25 * 0.9 + 0.5 * 0.5 + 0.25 * 0.3, 1e-15);
});

test("Definition 3: G(theta) <= 1, so the absorbed update is sub-convex", () => {
  for (const seed of SEEDS) {
    const m = randomModels(seed, 30, 4);
    for (const theta of [0, 0.3, 0.7, 1]) {
      const G = acceptedGain(m.map((x) => x.capability), m.map((x) => x.validation), theta);
      assert.ok(G >= 0 && G <= 1, `G = ${G}`);
    }
    // All scores 1 and theta = 0 gives exactly G = 1.
    close(acceptedGain([0.3, 0.7, 2], [1, 1, 1], 0), 1, 1e-15);
  }
});

test("Proposition 3: mean and variance of the update", () => {
  const models: ResponseModel[] = [
    { capability: 1, validation: 0.8, signal: [1, 2], sigma: 0.5 },
    { capability: 3, validation: 0.4, signal: [0, -1], sigma: 1 },
  ];
  const m = stepMoments(models, { alpha: 2, theta: 0 }, [1, 0]);
  // a = [0.25 * 0.8, 0.75 * 0.4] = [0.2, 0.3]
  close(m.mean[0], 2 * 0.2 * 1, 1e-15);
  close(m.mean[1], 2 * (0.2 * 2 + 0.3 * -1), 1e-15);
  close(m.traceCov, 4 * 2 * (0.04 * 0.25 + 0.09 * 1), 1e-15);
  close(m.mse!, norm(m.bias!) ** 2 + m.traceCov, 1e-15);
  // A Monte Carlo of r_i = s_i + eps_i agrees with the closed form.
  const z = gaussian(7);
  const R = 20000;
  const sum = [0, 0];
  let sq = 0;
  for (let r = 0; r < R; r++) {
    const contribs = models.map((x) => ({ capability: x.capability, validation: x.validation, response: x.signal.map((s) => s + x.sigma * z()) }));
    const u = convergeStep([0, 0], contribs, { alpha: 2, theta: 0 }).update;
    sum[0] += u[0]; sum[1] += u[1]; sq += u[0] ** 2 + u[1] ** 2;
  }
  const mean = sum.map((s) => s / R);
  close(mean[0], m.mean[0], 0.01);
  close(mean[1], m.mean[1], 0.01);
  rel(sq / R - norm(mean) ** 2, m.traceCov, 0.03, "trace of covariance");
});

test("Proposition 3(i): variance and gain are non-increasing in theta", () => {
  for (const seed of SEEDS) {
    const models = randomModels(seed, 40, 5);
    let prevVar = Infinity;
    let prevGain = Infinity;
    for (let theta = 0; theta <= 1.0000001; theta += 0.025) {
      const t = Math.min(theta, 1);
      const v = stepMoments(models, { alpha: 1.5, theta: t }).traceCov;
      const g = acceptedGain(models.map((x) => x.capability), models.map((x) => x.validation), t);
      assert.ok(v <= prevVar + 1e-15 && g <= prevGain + 1e-15, `seed ${seed} theta ${t}`);
      prevVar = v;
      prevGain = g;
    }
  }
});

test("Proposition 3(ii): above theta*, bias is (alpha K - 1) g and its norm does not fall", () => {
  const g = [0.6, -0.8];
  const thetaStar = 0.5;
  const u = mulberry32(11);
  // Aligned responses (v >= theta*) have s_i = kappa_i g; misaligned ones (v < theta*) point elsewhere.
  const models: (ResponseModel & { kappa: number })[] = Array.from({ length: 25 }, () => {
    const aligned = u() < 0.7;
    const kappa = u();
    return {
      capability: 0.1 + 0.9 * u(),
      validation: aligned ? thetaStar + (1 - thetaStar) * u() : thetaStar * u(),
      signal: aligned ? g.map((x) => kappa * x) : [u() - 0.5, u() + 1],
      sigma: 0.2,
      kappa,
    };
  });
  const alpha = 1;
  const caps = models.map((m) => m.capability);
  const vals = models.map((m) => m.validation);
  const K = (theta: number) => effectiveWeights(caps, vals, theta).reduce((s, a, i) => s + a * (vals[i] >= thetaStar ? models[i].kappa : 0), 0);
  assert.ok(alpha * K(thetaStar) <= 1);
  let prev = -Infinity;
  for (let theta = thetaStar; theta <= 1; theta += 0.02) {
    const b = stepMoments(models, { alpha, theta }, g).bias!;
    const k = alpha * K(theta) - 1;
    close(b[0], k * g[0], 1e-12);
    close(b[1], k * g[1], 1e-12);
    assert.ok(norm(b) >= prev - 1e-12, `bias norm fell at theta ${theta}`);
    prev = norm(b);
  }
  // Below theta*, the misaligned term alpha * sum a_i u_i is added.
  const lo = 0.2;
  const extra = [0, 0];
  effectiveWeights(caps, vals, lo).forEach((a, i) => {
    if (vals[i] < thetaStar) { extra[0] += alpha * a * models[i].signal[0]; extra[1] += alpha * a * models[i].signal[1]; }
  });
  const b = stepMoments(models, { alpha, theta: lo }, g).bias!;
  const k = alpha * K(lo) - 1;
  close(b[0], k * g[0] + extra[0], 1e-12);
  close(b[1], k * g[1] + extra[1], 1e-12);
});

test("Proposition 4(i): bounded responses move at most alpha_t B per round and a summable schedule converges", () => {
  const B = 2;
  const z = gaussian(5);
  const respond = () =>
    Array.from({ length: 10 }, (_, i) => {
      const r = [z(), z(), z()];
      const s = B / Math.max(B, norm(r)) * 0.999;
      return { capability: 1 + i, validation: 0.5 + 0.05 * i, response: r.map((x) => x * s) };
    });
  const schedule = (t: number) => 1 / (t + 1) ** 2;
  const res = refine([0, 0, 0], respond, { alpha: schedule, theta: 0.3, rounds: 400 });
  for (let t = 0; t < 400; t++) {
    const step = norm(res.trajectory[t + 1].map((x, k) => x - res.trajectory[t][k]));
    assert.ok(step <= schedule(t) * B + 1e-12, `round ${t}`);
  }
  // Cauchy tail: ||I_400 - I_200|| <= B sum_{u >= 200} alpha_u < B / 199.
  const tail = norm(res.trajectory[400].map((x, k) => x - res.trajectory[200][k]));
  assert.ok(tail <= B / 199);
});

/** Contractive responders f_i = kappa_i (I* - I) + e_i used by the Proposition 4(ii) tests. */
function contractive(target: number[], kappas: number[], eps: number, seed: number) {
  const z = gaussian(seed);
  const u = mulberry32(seed + 1);
  const vals = kappas.map(() => 0.4 + 0.6 * u());
  const caps = kappas.map(() => 0.2 + u());
  const respond = (idea: readonly number[]) =>
    kappas.map((k, i) => {
      const e = target.map(() => z());
      const en = norm(e);
      return { capability: caps[i], validation: vals[i], response: target.map((x, j) => k * (x - idea[j]) + (eps * e[j]) / en) };
    });
  return { respond, caps, vals };
}

test("Proposition 4(ii): exact contraction when eps = 0, and the stated error bound with eps > 0", () => {
  const target = [1, -2, 0.5];
  const kappas = [0.2, 0.9, 0.5, 0.7, 1.0];
  for (const alpha of [0.5, 1, 2, 3]) {
    const { respond, caps, vals } = contractive(target, kappas, 0, 21);
    const a = effectiveWeights(caps, vals, 0.5);
    const lambda = effectiveGain(a, kappas, alpha);
    const rho = contractionFactor(lambda);
    const res = refine([0, 0, 0], respond, { alpha, theta: 0.5, rounds: 25, target });
    res.errors!.forEach((e, t) => close(e, rho ** t * res.errors![0], 1e-9 * res.errors![0], `alpha ${alpha} t ${t}`));
  }
  for (const seed of SEEDS) {
    const eps = 0.05;
    const alpha = 1.5;
    const { respond, caps, vals } = contractive(target, kappas, eps, seed);
    const lambda = effectiveGain(effectiveWeights(caps, vals, 0.5), kappas, alpha);
    assert.ok(lambda > 0 && lambda < 2);
    const rho = contractionFactor(lambda);
    const res = refine([0, 0, 0], respond, { alpha, theta: 0.5, rounds: 60, target });
    res.errors!.forEach((e, t) => assert.ok(e <= errorBound(t, rho, res.errors![0], alpha, eps) + 1e-12, `seed ${seed} t ${t}`));
  }
});

test("Proposition 4(ii): alpha < 2 / kappa_max keeps lambda < 2; lambda > 2 diverges at rate (lambda - 1)^t", () => {
  assert.equal(stableAlphaBound(0.5), 4);
  assert.equal(contractionFactor(0.5, 1.8), 0.8);
  const kappas = [0.3, 0.8, 1.0];
  const u = mulberry32(3);
  for (let i = 0; i < 200; i++) {
    const caps = kappas.map(() => 0.1 + u());
    const vals = kappas.map(() => u());
    const a = effectiveWeights(caps, vals, u());
    assert.ok(effectiveGain(a, kappas, 0.999 * stableAlphaBound(1.0)) < 2);
  }
  // Every node fully validated with kappa = 1: lambda = alpha.
  const target = [3, 4];
  const respond = (idea: readonly number[]) => [1, 2].map((c) => ({ capability: c, validation: 1, response: target.map((x, j) => x - idea[j]) }));
  const res = refine([0, 0], respond, { alpha: 2.5, theta: 0.9, rounds: 12, target });
  res.errors!.forEach((e, t) => assert.ok(e >= 1.5 ** t * 5 * (1 - 1e-12), `t ${t}`));
});

test("Corollary 1: a Robbins-Monro schedule averages out zero-mean noise that a constant rate cannot", () => {
  for (const seed of SEEDS) {
    const target = [1, 1, 1, 1];
    const kappas = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    const constant = refine([0, 0, 0, 0], contractive(target, kappas, 0.5, seed).respond, { alpha: 1.5, theta: 0, rounds: 2000, target });
    const decreasing = refine([0, 0, 0, 0], contractive(target, kappas, 0.5, seed).respond, { alpha: (t) => 1.5 / (1 + t / 10), theta: 0, rounds: 2000, target });
    const tailMean = (e: number[]) => e.slice(-200).reduce((a, b) => a + b, 0) / 200;
    assert.ok(tailMean(decreasing.errors!) < 0.25 * tailMean(constant.errors!), `seed ${seed}`);
  }
});

test("Table 2: MSE of one convergence step against theta (alpha = 2), across seeds", () => {
  const thetas = Array.from({ length: 20 }, (_, i) => (i * 0.95) / 19);
  // Paper: N, MSE at theta = 0, optimal theta, MSE at optimum, MSE at 0.95, accepted at optimum.
  const table: [number, number, number, number, number, number][] = [
    [5, 0.262, 0.55, 0.217, 0.472, 0.644],
    [20, 0.092, 0.55, 0.068, 0.319, 0.649],
    [100, 0.044, 0.5, 0.026, 0.275, 0.667],
  ];
  for (const seed of SEEDS) {
    const reductions: number[] = [];
    for (const [N, mse0, , mseOpt, mse95, accOpt] of table) {
      const pts = simulateGateSweep({ N, alpha: 2, thetas, replications: N === 100 ? 800 : 2000, seed });
      const best = pts.reduce((a, b) => (b.mse < a.mse ? b : a));
      const tag = `seed ${seed} N ${N}`;
      rel(pts[0].mse, mse0, 0.2, `${tag} MSE at 0`);
      rel(best.mse, mseOpt, 0.2, `${tag} MSE at optimum`);
      rel(pts[19].mse, mse95, 0.08, `${tag} MSE at 0.95`);
      close(best.acceptedFraction, accOpt, 0.07, `${tag} accepted fraction`);
      assert.ok(best.theta >= 0.4 && best.theta <= 0.75, `${tag} optimum theta ${best.theta}`);
      // U-shape: interior optimum below both ends.
      assert.ok(best.mse < pts[0].mse && best.mse < pts[19].mse);
      // With many nodes the gain comes mainly from the bias term (paper, N = 100: 0.0328 -> 0.0166 vs 0.0112 -> 0.0098).
      if (N >= 20) assert.ok(pts[0].bias2 - best.bias2 > pts[0].variance - best.variance, `${tag} bias drop`);
      if (N === 100) {
        close(pts[0].bias2, 0.0328, 0.008, `${tag} bias^2 at 0`);
        close(best.bias2, 0.0166, 0.003, `${tag} bias^2 at optimum`);
        close(pts[0].variance, 0.0112, 0.0015, `${tag} variance at 0`);
        close(best.variance, 0.0098, 0.0015, `${tag} variance at optimum`);
      }
      reductions.push(1 - best.mse / pts[0].mse);
    }
    // The gate helps more as N grows (paper: 17%, 26%, 40%).
    assert.ok(reductions[0] < reductions[1] && reductions[1] < reductions[2], `seed ${seed} ${reductions}`);
  }
});

test("Section 5.4: effective gain per unit alpha at theta = 0.6 (mean 0.42, 5th-95th 0.27-0.57)", () => {
  for (const seed of SEEDS) {
    const g = estimateGainPerAlpha({ theta: 0.6, draws: 5000, seed });
    close(g.mean, 0.42, 0.01, `seed ${seed} mean`);
    close(g.p05, 0.27, 0.015, `seed ${seed} p05`);
    close(g.p95, 0.57, 0.015, `seed ${seed} p95`);
    close(2 / g.mean, 4.7, 0.15, "predicted instability onset");
  }
});

test("Section 5.4: recursion converges for alpha <= 2, stays bounded at 4 and diverges at 6 (theta = 0.6)", () => {
  // Paper medians: after 10 rounds 0.087, 0.0091, 0.0125; after 40 rounds 0.0028, 0.0056, 0.0124.
  const paper: Record<number, [number, number]> = { 0.5: [0.087, 0.0028], 1: [0.0091, 0.0056], 2: [0.0125, 0.0124] };
  for (const seed of SEEDS) {
    for (const alpha of [0.5, 1, 2]) {
      const e = simulateRefinement({ alpha, theta: 0.6, rounds: 40, runs: 200, seed }).medianError;
      rel(e[10], paper[alpha][0], 0.2, `seed ${seed} alpha ${alpha} t10`);
      rel(e[40], paper[alpha][1], 0.2, `seed ${seed} alpha ${alpha} t40`);
    }
    const four = simulateRefinement({ alpha: 4, theta: 0.6, rounds: 40, runs: 200, seed }).medianError;
    assert.ok(four[40] < 0.3 && four[40] > 0.02, `seed ${seed} alpha 4 levels off, got ${four[40]}`);
    const six = simulateRefinement({ alpha: 6, theta: 0.6, rounds: 40, runs: 200, seed });
    assert.ok(six.medianError[10] > 100, `seed ${seed} alpha 6 t10 ${six.medianError[10]}`);
    assert.ok(six.capRound !== undefined && six.capRound >= 20 && six.capRound <= 27, `seed ${seed} cap round ${six.capRound}`);
  }
});

test("Section 5.4 grid: a stricter gate widens the stable range of alpha (30 rounds, 60 runs)", () => {
  for (const seed of SEEDS) {
    const final = (alpha: number, theta: number) => simulateRefinement({ alpha, theta, rounds: 30, runs: 60, seed }).medianError[30];
    assert.ok(final(5, 0) > 1e3, "alpha 5, theta 0 diverges");
    close(final(5, 0.9), 0.016, 0.005, "alpha 5, theta 0.9");
    close(final(6, 0.9), 0.021, 0.007, "alpha 6, theta 0.9");
    assert.ok(final(6, 0.8) > 1e3, "alpha 6, theta 0.8 diverges");
    for (const theta of [0, 0.9]) {
      const e = final(0.25, theta);
      assert.ok(e >= 0.03 && e <= 0.13, `alpha 0.25 theta ${theta} too slow, got ${e}`);
    }
    close(final(0.5, 0.6), 0.0027, 0.0005, "best cell");
  }
});

test("seeded simulations are deterministic", () => {
  const a = simulateGateSweep({ N: 10, alpha: 2, thetas: [0, 0.5], replications: 50, seed: 9 });
  const b = simulateGateSweep({ N: 10, alpha: 2, thetas: [0, 0.5], replications: 50, seed: 9 });
  assert.deepEqual(a, b);
  assert.deepEqual(simulateRefinement({ alpha: 1, theta: 0.6, rounds: 5, runs: 5, seed: 4 }), simulateRefinement({ alpha: 1, theta: 0.6, rounds: 5, runs: 5, seed: 4 }));
  assert.notDeepEqual(a, simulateGateSweep({ N: 10, alpha: 2, thetas: [0, 0.5], replications: 50, seed: 10 }));
});

test("invalid inputs throw RangeError", () => {
  const ok: Contribution[] = [{ capability: 1, validation: 0.5, response: [1, 0] }];
  const bad: [string, () => unknown][] = [
    ["alpha 0", () => convergeStep([0, 0], ok, { alpha: 0, theta: 0.5 })],
    ["alpha NaN", () => convergeStep([0, 0], ok, { alpha: NaN, theta: 0.5 })],
    ["theta > 1", () => convergeStep([0, 0], ok, { alpha: 1, theta: 1.1 })],
    ["theta < 0", () => convergeStep([0, 0], ok, { alpha: 1, theta: -0.1 })],
    ["no contributions", () => convergeStep([0, 0], [], { alpha: 1, theta: 0.5 })],
    ["dimension mismatch", () => convergeStep([0, 0, 0], ok, { alpha: 1, theta: 0.5 })],
    ["empty idea", () => convergeStep([], ok, { alpha: 1, theta: 0.5 })],
    ["capability 0", () => capabilityWeights([1, 0])],
    ["validation > 1", () => effectiveWeights([1], [1.2], 0)],
    ["length mismatch", () => effectiveWeights([1, 2], [0.5], 0)],
    ["negative sigma", () => stepMoments([{ capability: 1, validation: 1, signal: [1], sigma: -1 }], { alpha: 1, theta: 0 })],
    ["negative kappa", () => effectiveGain([0.5], [-1], 1)],
    ["lambda order", () => contractionFactor(1.5, 0.5)],
    ["kappaMax 0", () => stableAlphaBound(0)],
    ["rho 1", () => errorBound(3, 1, 1, 1, 0)],
    ["rounds -1", () => refine([0], () => ok, { alpha: 1, theta: 0, rounds: -1 })],
    ["N 0", () => simulateGateSweep({ N: 0, alpha: 2, thetas: [0], replications: 10 })],
    ["replications 1", () => simulateGateSweep({ N: 5, alpha: 2, thetas: [0], replications: 1 })],
    ["empty thetas", () => simulateGateSweep({ N: 5, alpha: 2, thetas: [], replications: 10 })],
    ["active > pool", () => simulateRefinement({ alpha: 1, theta: 0.5, rounds: 1, runs: 1, pool: 10, active: 20 })],
    ["misaligned rate", () => simulateRefinement({ alpha: 1, theta: 0.5, rounds: 1, runs: 1, setup: { misalignedRate: 2 } })],
    ["draws 0", () => estimateGainPerAlpha({ theta: 0.6, draws: 0 })],
  ];
  for (const [name, fn] of bad) assert.throws(fn, RangeError, name);
});
