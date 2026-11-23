# stimulian

Open tooling for **Stimuli Network** — https://stimuli.network

Stimuli Network pairs client organizations with student technologists working as
independent contractors. Work is paid by milestone: autonomous bots check the
delivered code against agreed acceptance criteria, and only a verified milestone
can release the client's funds from a **non-custodial Kaspa escrow**. Stimuli
Network never holds the money.

This repository holds the pieces that make that loop work, starting with the
milestone verifier.

> Stimuli Network is a future business idea, not an operating business.

## Milestone verifier

```bash
node src/cli.ts keygen --out verifier.pem          # prints the public key
node src/cli.ts check  --spec examples/river-rescue-m1.json --repo-dir ../client-repo
node src/cli.ts prove  --spec milestone.json --repo-dir ../client-repo \
  --commit <40-char sha> --key verifier.pem --out proof.json
node src/cli.ts verify-proof --proof proof.json --spec milestone.json --trusted-key <public key>
```

Requires Node.js 22.18 or newer. No dependencies. `npm test` runs the suite.

To use it on a client project, copy `examples/workflows/` into the client repo's
`.github/workflows/`, commit the agreed spec to `.stimuli/milestone.json`, and add
the verifier key as the `STIMULI_VERIFIER_KEY` secret.

Build a milestone's Kaspa escrow address with `node src/cli.ts escrow` (testnet only for now).

## Cascade model

`src/model/cascade.ts` implements the propagation model from A. Mowrey,
*From Spark to Swarm* (Stimuli.Network working paper, November 2026): with fan-out
`n` and per-hop fidelity `delta`, shared value fades when `n * delta < 1` and
compounds when it is above 1. It gives closed-form reach and value, the regime,
survival probability, and a seeded Monte Carlo check, tested against the paper's
Table 1. Try `node src/cli.ts cascade --n 4 --delta 0.3`. Details in
[docs/cascade-model.md](docs/cascade-model.md).

See [docs/architecture.md](docs/architecture.md) for the trust model, the escrow
design, and the roadmap.
