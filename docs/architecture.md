# Architecture

Stimuli Network's promise to both sides is simple: **clients pay only for code
that meets the agreed criteria, and contractors get paid the moment it does,**
without Stimuli Network ever holding the money.

## The milestone loop

```
 client + contractor            contractor              bots (CI)                 Kaspa
 ───────────────────            ──────────              ─────────                 ─────
 agree milestone spec  ──►  open pull request  ──►  milestone-tests (no secrets)
 hash = sha256(spec)                                         │
 client funds escrow ─────────────────────────────────────────┼──────────────►  P2SH escrow UTXO
   bound to spec hash                                         ▼                   (client | contractor | verifier)
                                                   milestone-proof (signs)
                                                   reads files + check status,
                                                   never runs contractor code
                                                             │ signed proof
                                                             ▼
                                                   verifier co-signs release ──►  funds go client → contractor
```

1. **Spec.** A milestone is a JSON document (`stimuli.milestone/v1`) committed to
   the client repo at `.stimuli/milestone.json`. Its canonical SHA-256 is what both
   parties agree to and what the escrow is bound to. See `examples/`.
2. **Tests.** The contractor's code runs in an unprivileged job on the pull request.
3. **Proof.** A second job, holding the verifier key, reads the *agreed* spec from
   the default branch, checks files at the delivered commit, asks GitHub whether the
   test check succeeded on that exact commit, and signs a `stimuli.proof/v1`.
4. **Settlement.** The proof's `digest` is what the verifier's escrow key co-signs.

## Why the signing job never runs contractor code

If the job holding the key ran `npm test`, a malicious delivery could read the key
or rewrite the results. So execution and signing are split: `command` criteria
are refused unless `--allow-exec` is passed, and the proof workflow uses only
read-only criteria plus `github_check`, whose answer comes from GitHub, not from
the contractor's code.

## Criteria types (v1)

| type | passes when |
|------|-------------|
| `file_exists` | the path exists in the delivered tree |
| `file_contains` | the file matches a regex |
| `forbid_pattern` | no file under `paths` matches (secrets, keys, tokens) |
| `github_check` | the named check run concluded `success` on the delivered commit |
| `command` | a shell command exits 0 (local use only; needs `--allow-exec`) |

## Escrow (next milestone: design, testnet only)

Target: a 2-of-3 Kaspa P2SH script over Schnorr keys of **client**, **contractor**,
and **Stimuli verifier**, plus a timelocked refund path to the client.

- Normal release: contractor + verifier sign, after a valid proof.
- Dispute: client + contractor can always settle between themselves.
- Abandonment: after the deadline, the client alone recovers the funds.

No single party, Stimuli Network included, can move the funds alone, which is
the non-custodial property the business plan relies on. Kaspa's Crescendo
upgrade (2025) added transaction-introspection opcodes (KIP-10), which may later
let the script itself enforce that the output pays the contractor's address and
amount from the spec; that needs to be confirmed against current kaspad before
it is relied on.

Open items before any mainnet use:
- Verifier keys move from Ed25519 to the Schnorr (secp256k1) scheme Kaspa uses,
  or the Ed25519 proof key is kept separate and attests to the escrow key.
- Legal review of the escrow flow (money transmission) with counsel.
- Work only on testnet (TN10/TN11) until both are done.

## Roadmap

1. ✅ Milestone verifier: spec, criteria, signed proofs, GitHub workflows.
2. Kaspa testnet escrow: script builder, funding and release transactions.
3. Client/contractor onboarding: milestone spec builder, B2B agreement and IP
   assignment templates, contractor verification.
4. Bot bounties: automated audits and test verification as operational credits.
