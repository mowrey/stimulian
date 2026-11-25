# stimulian

Open tooling for **Stimuli Network** — https://stimuli.network

Stimuli Network builds software for clients, paid by milestone in US dollars.
Each milestone has written acceptance checks, and a bot verifies the delivered
code against them at the exact commit. A non-custodial **Kaspa escrow**, in which
Stimuli Network never holds the money, is in testnet and is not offered to
clients until it clears legal review.

This repository holds the open tooling behind that loop: the milestone verifier,
the testnet escrow builder, and the working paper's models.

## Milestone verifier

```bash
node src/cli.ts keygen --out verifier.pem          # prints the public key
node src/cli.ts check  --spec examples/river-rescue-m1.json --repo-dir ../client-repo
node src/cli.ts prove  --spec milestone.json --repo-dir ../client-repo \
  --commit <40-char sha> --key verifier.pem --out proof.json
node src/cli.ts verify-proof --proof proof.json --spec milestone.json --trusted-key <public key>
```

Requires Node.js 22.18 or newer. No runtime dependencies. `npm test` runs the suite;
`npm ci && npm run typecheck` runs the strict TypeScript check.

To use it on a client project, copy `examples/workflows/` into the client repo's
`.github/workflows/`, commit the agreed spec to `.stimuli/milestone.json`, and add
the verifier key as the `STIMULI_VERIFIER_KEY` secret.

Build a milestone's Kaspa escrow address with `node src/cli.ts escrow` (testnet only; mainnet is refused).
Before co-signing a release, a verifier runs `node src/cli.ts cosign-check` to apply its
signing policy, including screening against OFAC's SDN address list bundled in `data/`
(refresh with `npm run sdn:update`). See [docs/compliance.md](docs/compliance.md),
[docs/sanctions-screening.md](docs/sanctions-screening.md) and
[docs/key-custody.md](docs/key-custody.md) (not legal advice). Mainnet and fees are
locked in code (`src/compliance/gates.ts`) until legal review.

## Cascade model

`src/model/cascade.ts` implements the propagation model from A. Mowrey,
*From Spark to Swarm* (Stimuli.Network working paper, November 2026): with fan-out
`n` and per-hop fidelity `delta`, shared value fades when `n * delta < 1` and
compounds when it is above 1. It gives closed-form reach and value, the regime,
survival probability, and a seeded Monte Carlo check, tested against the paper's
Table 1. Try `node src/cli.ts cascade --n 4 --delta 0.3`. Details in
[docs/cascade-model.md](docs/cascade-model.md).

## Convergence model

`src/model/convergence.ts` implements the paper's convergence step and refinement
loop: an initiator absorbs only responses whose validation score passes a gate
`theta`, weighted by capability, at absorption rate `alpha`. A moderate gate cuts
the error from systematically wrong contributors, and `alpha` has a stability
bound that a stricter gate widens. It includes the paper's bias-variance and
stability results and seeded simulations checked against Table 2 and Section 5.4.
Try `node src/cli.ts gate --nodes 20` or `node src/cli.ts refine --alpha 1`.
Details in [docs/convergence-model.md](docs/convergence-model.md).

See [docs/architecture.md](docs/architecture.md) for the trust model, the escrow
design, and the roadmap.

## License

MIT. See [LICENSE](LICENSE).
