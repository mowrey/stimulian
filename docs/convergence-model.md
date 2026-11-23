# Convergence model: absorbing feedback without being misled

`src/model/convergence.ts` implements the convergence phase and the recursive
refinement loop of the model in A. Mowrey, *From Spark to Swarm: A Branching-Process
Model of Idea Evolution in Capability-Weighted Node Ecosystems*, Stimuli.Network
working paper, November 2026 (Definitions 3 and 5, Assumption 1, Propositions 3
and 4, Corollary 1, Section 5 Experiments 2 and 3). The propagation phase lives
next to it in [`cascade.ts`](cascade-model.md).

## The idea

An initiator holds an idea `I` (a vector: a spec, a design, a plan) and gets `N`
responses `r_i` back from nodes of capability `c_i`. Each response gets a
validation score `v_i` in [0, 1]. Only responses that pass the gate `v_i >= theta`
are absorbed, weighted by capability:

```
I_1 = I_0 + alpha * sum_i w_i v_i 1[v_i >= theta] r_i,    w_i = c_i / sum_j c_j
```

Repeating this with a fresh set of contributors each round is the refinement loop
(the paper's equation 5). Two knobs decide how it behaves:

- **The gate `theta`** trades bias against variance (Proposition 3). Raising it
  always lowers variance and the total accepted gain `G(theta) = sum_i a_i <= 1`.
  While it is still filtering out misaligned responses it also lowers bias; past
  that point it only shrinks the step. The error is U-shaped in `theta`, and more
  contributors cut noise but not correlated error, which only the gate removes.
- **The absorption rate `alpha`** has a stability bound (Proposition 4). With
  contractive responses `f_i = kappa_i (I* - I) + e_i`, the effective gain
  `lambda = alpha * sum_i a_i kappa_i` must stay in (0, 2); `alpha < 2 / kappa_max`
  is enough. Larger `alpha` converges faster but to a higher noise floor
  (Corollary 1), and past the bound the loop oscillates and diverges. A stricter
  gate lowers `lambda`, so it widens the stable range of `alpha`.

The practical reading for Stimuli Network: when a milestone or a proposal gets
feedback from many reviewers, gate it (do not just weight it), absorb steadily
rather than over-reacting, and calibrate the bar to how many reviewers are likely
to be systematically wrong rather than to a fixed quality score.

## API

| function | paper | returns |
|---|---|---|
| `capabilityWeights(c)` | Def. 3 | `w_i = c_i / sum c_j` |
| `effectiveWeights(c, v, theta)` | Def. 3 | `a_i(theta) = w_i v_i 1[v_i >= theta]` |
| `acceptedGain(c, v, theta)` | Def. 3 | `G(theta)` |
| `convergeStep(idea, contributions, { alpha, theta })` | eq. (2) | `I_1`, the update, accepted flags, weights, `G` |
| `stepMoments(models, { alpha, theta }, g?)` | Prop. 3 | mean, `tr Cov`, bias and MSE of the update |
| `effectiveGain(a, kappa, alpha)` | Prop. 4(ii) | `lambda` |
| `contractionFactor(lambdaMin, lambdaMax?)` | Prop. 4(ii) | `rho` |
| `stableAlphaBound(kappaMax)` | Prop. 4(ii) | `2 / kappa_max` |
| `errorBound(t, rho, e0, alpha, eps)` | Prop. 4(ii) | `rho^t e0 + alpha eps / (1 - rho)` |
| `refine(I0, respond, { alpha, theta, rounds, target? })` | eq. (5) | trajectory, per-round `G`, errors; `alpha` may be a schedule |
| `simulateGateSweep({ N, alpha, thetas, replications, seed })` | Exp. 2 | bias^2, variance, MSE, accepted fraction per `theta` |
| `simulateRefinement({ alpha, theta, rounds, runs, seed })` | Exp. 3 | median error per round, round the cap was hit |
| `estimateGainPerAlpha({ theta, draws, seed })` | Sec. 5.4 | mean and 5th/95th percentiles of `lambda / alpha` |

`alpha` must be positive, `theta`, `v_i` in [0, 1], `c_i` positive, and all vectors
the same dimension; anything else throws a `RangeError`. Simulations use the
seeded PRNG from `cascade.ts`, so a seed always gives the same result.

```bash
node src/cli.ts gate --nodes 20 --alpha 2          # Table 2 row for N = 20
node src/cli.ts refine --alpha 1 --theta 0.6       # Experiment 3 curve for alpha = 1
```

## Checked against the paper

Exact, in `test/convergence.test.ts`: the weights and update of equation (2) on a
hand-computed case; `G(theta) <= 1`; Proposition 3's mean and `tr Cov` (also
against a Monte Carlo of Assumption 1); monotonicity of variance and gain in
`theta` (3(i)); the bias `(alpha K - 1) g` above `theta*` and the extra misaligned
term below it (3(ii)); the step bound and Cauchy tail for bounded responses
(4(i)); exact contraction `rho^t`, the error bound, `alpha < 2 / kappa_max`, and
divergence at rate `(lambda - 1)^t` (4(ii)); and that a Robbins-Monro schedule
beats a constant rate under zero-mean noise (Corollary 1).

Simulated, with tolerances, on seeds 1, 2 and 3 (paper value, then this code at
the paper's sizes, seed 1):

| quantity | paper | here |
|---|---|---|
| Table 2, MSE at `theta = 0` (N = 5 / 20 / 100) | 0.262 / 0.092 / 0.044 | 0.259 / 0.094 / 0.049 |
| Table 2, MSE at optimum | 0.217 / 0.068 / 0.026 | 0.224 / 0.070 / 0.028 |
| Table 2, MSE at `theta = 0.95` | 0.472 / 0.319 / 0.275 | 0.477 / 0.322 / 0.279 |
| Table 2, accepted at optimum | 0.644 / 0.649 / 0.667 | 0.648 / 0.649 / 0.705 |
| Table 2, optimal `theta` | 0.55 / 0.55 / 0.50 | 0.55-0.65 across seeds |
| N = 100 squared bias, `theta = 0` to optimum | 0.0328 to 0.0166 | 0.036-0.038 to 0.017-0.018 |
| `lambda / alpha` at `theta = 0.6`, mean (5th-95th) | 0.42 (0.27-0.57) | 0.42 (0.27-0.57) |
| median error after 10 / 40 rounds, `alpha = 0.5` | 0.087 / 0.0028 | 0.090 / 0.0026 |
| same, `alpha = 1` | 0.0091 / 0.0056 | 0.0084 / 0.0054 |
| same, `alpha = 2` | 0.0125 / 0.0124 | 0.0123 / 0.0121 |
| `alpha = 6`: error after 10 rounds, round the cap is hit | 288, 23 | 262, 24 |
| grid, 30 rounds: `alpha = 5` with `theta` = 0 / 0.9 | 5.7e3 / 0.016 | 4.6e3 / 0.016 |
| grid: `alpha = 6, theta = 0.9`; best cell `alpha = 0.5, theta = 0.6` | 0.021; 0.0027 | 0.022; 0.0025 |

### Where it does not reproduce

- The paper's simulation script (`simulate.py`) is not published with the text, so
  the misaligned response ("a shared decoy direction, of magnitude about
  0.5 ||g|| plus noise") is reconstructed: a random unit decoy per replication or
  run, scaled by 0.5 ||g||, with the same noise as an aligned node.
- `alpha = 4`, `theta = 0.6`: the paper reports the error levelling off at 0.26;
  here it levels off near 0.05 (stable but noisy, as the paper says, at a lower
  floor). This rate sits near the instability onset (about 4.7), where the result
  is sensitive to the decoy details.
- Grid, `alpha = 5, theta = 0.8`: the paper reports 5.0; here it is 0.8-1.8
  depending on the seed. Same marginal-stability caveat.
- The MSE-optimal `theta` comes out at 0.55-0.65 rather than 0.50-0.55, a flat
  minimum where neighbouring grid points differ by less than the noise.

## Limits

Ideas are vectors and contributions add linearly; validation scores are given,
not costly or strategic; capabilities are fixed; responders do not herd (paper,
Section 7). The paper's numbers, and these, are synthetic simulations, not
measurements of any real network.
