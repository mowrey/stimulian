import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cascadeReport,
  criticalSurvivalEstimate,
  cumulativeValue,
  extinctionByHop,
  extinctionProbability,
  limitValue,
  limitValueSensitivity,
  offspringPgf,
  reach,
  regime,
  simulateCascade,
  survivalProbability,
} from "../src/model/cascade.ts";

// Numbers below come from A. Mowrey, "From Spark to Swarm" (Stimuli.Network working
// paper, November 2026): Table 1 and Section 5.2, all with n = 4.
const at = (nd: number) => ({ n: 4, delta: nd / 4 });
const close = (actual: number, expected: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ${expected} +/- ${tol}, got ${actual}`);

test("Table 1: closed-form V_12 / vBar for n delta = 0.8, 1.0, 1.2", () => {
  close(cumulativeValue(at(0.8), 12), 4.725, 5e-4);
  assert.equal(cumulativeValue(at(1.0), 12), 13);
  close(cumulativeValue(at(1.2), 12), 48.497, 5e-4);
  close(cumulativeValue(at(1.2), 12, 2), 2 * 48.497, 1e-3, "scales with vBar");
});

test("Proposition 1: closed form equals the defining sum", () => {
  for (const nd of [0.5, 0.8, 1.0, 1.2, 1.6]) {
    for (const k of [0, 1, 5, 12]) {
      let s = 0;
      for (let j = 0; j <= k; j++) s += nd ** j;
      close(cumulativeValue(at(nd), k), s, 1e-9 * s, `nd=${nd} k=${k}`);
    }
  }
});

test("Section 5.2: reach at full fidelity R_12 = (4^13 - 1) / 3 = 22,369,621", () => {
  assert.equal(reach(4, 12), 22_369_621);
  assert.equal(reach(2, 0), 1);
  assert.equal(reach(3, 2), 13);
});

test("Proposition 2: regimes and the fading limit V_inf = vBar / (1 - n delta)", () => {
  assert.equal(regime(at(0.8)), "fading");
  assert.equal(regime(at(1.0)), "steady");
  assert.equal(regime(at(1.2)), "compounding");
  close(limitValue(at(0.8)), 5, 1e-9, "paper: saturates near V_inf / vBar = 5");
  assert.equal(limitValue(at(1.0)), Infinity);
  assert.equal(limitValue(at(1.2)), Infinity);
  // Remark 1: sensitivity n vBar / (1 - n delta)^2 blows up near the threshold.
  close(limitValueSensitivity(at(0.8)), 4 / 0.04, 1e-6);
  assert.ok(limitValueSensitivity(at(0.99)) > 100 * limitValueSensitivity(at(0.8)));
});

test("Proposition 2: extinction q is the smallest root of q = (1 - delta + delta q)^n", () => {
  assert.equal(extinctionProbability(at(0.8)), 1);
  assert.equal(extinctionProbability(at(1.0)), 1);
  for (const nd of [1.2, 1.5, 2, 3.6]) {
    const p = at(nd);
    const q = extinctionProbability(p);
    assert.ok(q > 0 && q < 1, `q in (0, 1) for nd=${nd}`);
    close(offspringPgf(p, q), q, 1e-10, `fixed point nd=${nd}`);
  }
});

test("Section 5.2: asymptotic survival 1 - q is 0.402 at n delta = 1.2 and 0.710 at 1.5", () => {
  close(survivalProbability(at(1.2)), 0.402, 5e-4);
  close(survivalProbability(at(1.5)), 0.710, 5e-4);
});

test("Remark 1 / Section 5.2: critical survival estimate 2 / (sigma^2 k) is about 0.067 at k = 40", () => {
  close(criticalSurvivalEstimate(at(1.0), 40), 0.0667, 5e-4);
});

test("Table 1: exact extinction within 13 hops matches the simulated fractions 0.977, 0.840, 0.591", () => {
  // Table 1 reports Monte Carlo fractions (4,000 runs); the exact values are phi^13(0).
  close(extinctionByHop(at(0.8), 13), 0.977, 0.01);
  close(extinctionByHop(at(1.0), 13), 0.840, 0.01);
  close(extinctionByHop(at(1.2), 13), 0.591, 0.015);
  assert.equal(extinctionByHop(at(1.2), 0), 0);
});

test("Monte Carlo cascade tracks the closed form (Table 1 setup: k = 12, 4,000 runs)", () => {
  for (const nd of [0.8, 1.0, 1.2]) {
    const sim = simulateCascade(at(nd), { hops: 12, runs: 4000, seed: 2026 });
    const exact = cumulativeValue(at(nd), 12);
    // The paper's own runs land within about 3.5%; heavy tails at n delta > 1 need more room.
    close(sim.meanCumulative, exact, (nd > 1 ? 0.1 : 0.05) * exact, `mean V_12 nd=${nd}`);
    close(sim.extinctFraction, extinctionByHop(at(nd), 12), 0.03, `extinct by hop 12 nd=${nd}`);
    close(sim.extinctFraction + sim.survivalFraction, 1, 1e-12);
  }
});

test("simulation is reproducible from its seed", () => {
  const a = simulateCascade(at(1.1), { hops: 10, runs: 300, seed: 7 });
  const b = simulateCascade(at(1.1), { hops: 10, runs: 300, seed: 7 });
  assert.deepEqual(a, b);
});

test("inputs outside the model are rejected", () => {
  assert.throws(() => cumulativeValue({ n: 1, delta: 0.5 }, 3), /n must be/);
  assert.throws(() => cumulativeValue({ n: 4, delta: 1 }, 3), /delta must be/);
  assert.throws(() => cumulativeValue({ n: 4, delta: 0.2 }, -1), /k must be/);
  assert.throws(() => reach(4, 1.5), /k must be/);
});

test("cascadeReport summarises one parameter set", () => {
  const r = cascadeReport(at(1.2), 12);
  assert.equal(r.regime, "compounding");
  assert.equal(r.reach, 22_369_621);
  close(r.cumulativeValue, 48.497, 5e-4);
  close(r.survivalProbability, 0.402, 5e-4);
});
