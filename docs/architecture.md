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

## Escrow (testnet)

`src/kaspa/escrow.ts` builds a P2SH escrow whose address is derived from the
milestone spec hash, the three parties' keys, and the refund deadline:

```
<specSha256> OP_DROP
OP_IF
  OP_2 <client> <contractor> <verifier> OP_3 OP_CHECKMULTISIG
OP_ELSE
  <refundLockTime> OP_CHECKLOCKTIMEVERIFY <client> OP_CHECKSIG
OP_ENDIF
```

- **Release:** contractor + verifier sign after a valid proof.
- **Dispute:** client + contractor can always settle between themselves.
- **Abandonment:** after the deadline, the client alone recovers the funds.
  The CLI refuses a timestamp deadline that has already passed and warns when
  it is more than a year away.

No single party, Stimuli Network included, can move the funds alone: the
non-custodial property the business plan relies on. Changing any term (spec,
keys, deadline, network) changes the address, so a funded address is itself
proof of what was agreed.

```bash
node src/cli.ts escrow --spec milestone.json \
  --client-key <hex> --contractor-key <hex> --verifier-key <hex> \
  --refund-after 2027-03-01
```

Encoding follows rusty-kaspa (`crypto/txscript`, `crypto/addresses`): 32-byte
x-only Schnorr keys, BLAKE2b-256 script hash, `OP_CHECKMULTISIG` with signatures
in key order and no dummy element, `OP_CHECKLOCKTIMEVERIFY` that pops its operand,
lock times below 500,000,000,000 read as DAA scores and above as Unix ms.
Address encoding is tested against rusty-kaspa's own vectors.

Open items before any mainnet use:
- Build and sign the funding and release transactions (Kaspa sighash) against
  the official Kaspa WASM SDK, and run the full flow on testnet.
- Give the verifier a Schnorr (secp256k1) key; the Ed25519 proof key attests to it.
- Legal review of the escrow flow (money transmission) with counsel.
- Kaspa's newer introspection opcodes (KIP-10) could let the script itself
  enforce the payout address and amount; confirm what mainnet supports first.

## Roadmap

1. ✅ Milestone verifier: spec, criteria, signed proofs, GitHub workflows.
2. ✅ Kaspa escrow script and address builder.
3. Testnet transactions: fund, release, refund via the Kaspa WASM SDK.
4. Client/contractor onboarding: milestone spec builder, B2B agreement and IP
   assignment templates, contractor verification.
5. Bot bounties: automated audits and test verification as operational credits.
