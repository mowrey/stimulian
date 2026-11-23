# Cascade model: how far a result travels

`src/model/cascade.ts` implements the propagation phase of the model in
A. Mowrey, *From Spark to Swarm: A Branching-Process Model of Idea Evolution in
Capability-Weighted Node Ecosystems*, Stimuli.Network working paper, November 2026
(Definition 4, Propositions 1 and 2, Remark 1, Table 1).

## The idea

Something worth sharing (a verified milestone, an open tool, a referral) is
passed to `n` peers, each of whom passes it to `n` more, and so on. Each hop keeps
only a fraction `delta` of the original value: summaries lose detail, trust decays.
Everything about the outcome is decided by one number, the critical quantity
`m = n * delta`:

| `n * delta` | regime        | delivered value as hops grow              |
|-------------|---------------|-------------------------------------------|
| below 1     | fading        | levels off at `vBar / (1 - n * delta)`    |
| exactly 1   | steady        | grows linearly, `vBar * (k + 1)`          |
| above 1     | compounding   | grows geometrically                       |

Read as a random process (each recipient forwards to each of its `n` peers with
probability `delta`), the number of active recipients per hop is a Galton-Watson
branching process with Binomial(`n`, `delta`) offspring. It dies out for sure when
`n * delta <= 1`; above that it survives with probability `1 - q`, where `q` is
the smallest root of `q = (1 - delta + delta * q)^n`.

The practical reading for Stimuli Network: getting fan-out times fidelity just
above one is enough for word of mouth to compound, and improving fidelity
(clear write-ups, provenance, reputation) pays off most near that threshold,
where the sensitivity `n * vBar / (1 - n * delta)^2` blows up.

## API

| function | paper | returns |
|---|---|---|
| `criticalQuantity({ n, delta })` | `n delta` | mean offspring `m` |
| `regime(p)` | Prop. 2 | `"fading" \| "steady" \| "compounding"` |
| `reach(n, k)` | eq. (3) | `R_k`, nodes reached in `k` hops at full fidelity |
| `cumulativeValue(p, k, vBar = 1)` | eq. (4), Prop. 1 | `V_k` |
| `limitValue(p, vBar = 1)` | Prop. 2(i) | `V_inf`, or `Infinity` when `m >= 1` |
| `limitValueSensitivity(p, vBar = 1)` | Remark 1 | `dV_inf / d delta` |
| `extinctionProbability(p)` / `survivalProbability(p)` | Prop. 2 | `q` / `1 - q` |
| `extinctionByHop(p, k)` | Prop. 2 | exact `Pr(Z_k = 0)` |
| `criticalSurvivalEstimate(p, k)` | Remark 1 | `2 / (sigma^2 k)` at `m = 1` |
| `simulateCascade(p, { hops, runs, seed })` | Sec. 5.2 | seeded Monte Carlo of the cascade |
| `cascadeReport(p, hops)` | | all of the above in one object |

`n` is an integer of at least 2 and `delta` lies strictly between 0 and 1, as in
the paper; other inputs throw a `RangeError`. Simulations use a seeded PRNG, so a
seed always gives the same result.

```bash
node src/cli.ts cascade --n 4 --delta 0.3 --hops 12 --runs 4000
```

## Checked against the paper

`test/cascade.test.ts` pins the code to the paper's numbers (all with `n = 4`):

- Table 1, closed form `V_12 / vBar`: 4.725, 13.000 and 48.497 at `n delta` = 0.8, 1.0, 1.2.
- Table 1, extinction within 13 hops (the paper's Monte Carlo 0.977, 0.840, 0.591)
  against the exact `Pr(Z_13 = 0)`: 0.978, 0.841, 0.582.
- `V_inf / vBar = 5` at `n delta = 0.8`, and `R_12 = 22,369,621`.
- Survival `1 - q`: 0.402 at `n delta = 1.2` and 0.710 at 1.5.
- Critical estimate `2 / (sigma^2 k) = 0.067` at `k = 40`.
- A 4,000-run seeded simulation lands within 5% of the closed form for
  `n delta <= 1` and within 10% above it.

## Limits

The model assumes tree-like spread with no overlap between recipients, a fixed
fan-out and fixed fidelity (paper, Section 7). On real, finite, clustered networks
reach saturates and the effective `n` falls over time, so treat these numbers as
an upper bound on spread and a guide to which side of the threshold you are on,
not as a forecast. The paper's numbers are synthetic simulations, not measurements.
The other phases of the paper (gated, capability-weighted convergence and the
recursive refinement) are not implemented here yet.
