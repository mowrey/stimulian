# Verifier key custody policy

Engineering policy, not legal advice. Decided by Adrian Mowrey on 2026-11-23
("as safe and compliant as possible"). Stimuli Network runs on Kaspa testnet
only; nothing here authorizes mainnet use.

The verifier holds two kinds of key:

| Key | What it does | Code |
| --- | --- | --- |
| **Escrow co-signing key** (Kaspa, 32-byte x-only Schnorr) | One of the three keys in each 2-of-3 escrow. With one other party it can move funds, so it is the key that matters most. | `src/kaspa/escrow.ts`, `src/kaspa/policy.ts` |
| **Proof-signing key** (Ed25519) | Signs milestone proofs (`stimulian prove`) that the co-signer checks before signing a release. | `src/proof.ts`, `STIMULI_VERIFIER_KEY` in client CI |

The verifier never holds, receives or derives a client's or contractor's key.

## Testnet (today)

- **Per environment.** Each environment (local development, each client repo's
  CI, any demo) gets its own keys. A key is never copied between environments.
- **Rotated.** Rotate at least every 90 days, whenever someone with access
  leaves, and immediately on any suspicion of exposure. Old public keys are
  kept in a list so old proofs can still be checked, marked with the date they
  were retired.
- **Storage.** Proof keys may live in a GitHub Actions secret
  (`STIMULI_VERIFIER_KEY`) for the one repository that uses them. Key files are
  `0600`, never committed (`*.pem` and `*.key` are git-ignored), never pasted
  into the app, API, chat or issues. Testnet coins have no value, but testnet
  habits are mainnet habits.

## Mainnet (locked; requirements before it can be unlocked)

Mainnet is refused in code (`LEGAL_GATES.mainnetLegalReviewComplete = false`
in `src/compliance/gates.ts`; the API refuses mainnet networks and addresses as
well). Before that gate may change, every item below must be true:

1. **Hardware-backed key, held offline by Adrian.** The escrow co-signing key
   lives on a hardware signer (hardware wallet or HSM-grade device) that Adrian
   personally holds, kept offline when not signing. It is **never on a server**:
   not on Render, not in CI, not in a cloud KMS that a server can call, not in
   the database.
2. **Per-escrow derived keys.** Each escrow uses a fresh child key derived on the
   device (hardened derivation, one index per escrow, the index recorded with the
   escrow's public record). Compromise of one escrow's key must not expose
   another's, and the same public key never appears in two escrows.
3. **Signing ceremony.** Co-signing happens on the offline device only after
   `stimulian cosign-check` allows the exact transaction (proof valid for the
   bound spec, payout only to the agreed address, no operator output, sanctions
   list current and clear). The device displays the outputs and Adrian confirms
   them on the device screen.
4. **Proofs on mainnet.** A CI-held proof key may only produce advisory proofs.
   A proof that unlocks a mainnet release must be re-verified (`stimulian
   verify-proof` against the bound spec and a trusted key list) on Adrian's own
   machine before the co-signing ceremony; a mainnet proof key, if used, follows
   rules 1 and 5.
5. **Backups.** The device seed is backed up offline (metal or paper) in two
   physically separate places Adrian controls. No digital copy, photo or cloud
   note of the seed exists.
6. **Records.** For each co-signature: escrow id, derivation index, transaction
   id, the `cosign-check` output and the SDN list date, kept for five years
   (matching OFAC's recordkeeping expectation).

## Rotation and compromise procedure

**Planned rotation (testnet every 90 days; mainnet per device policy):**
1. Generate the new key in the target environment (`stimulian keygen` for proof
   keys; a new device account or derivation branch for co-signing keys).
2. Publish the new public key in the trusted key list; keep the old key valid
   only for escrows that already bound it.
3. New escrows bind only the new key. Retire the old key when its last escrow
   settles or refunds, and record the date.

**Suspected compromise:**
1. Stop co-signing immediately with the affected key (and, on mainnet, with the
   device) until the review below is done.
2. Remove the key from every trusted list and revoke any CI secret holding it.
3. For each open escrow bound to the key, tell both parties in writing. They can
   always settle together without the verifier (client + contractor), and the
   client can always take funds back after the refund deadline; the verifier key
   alone can never move funds. Offer to help them settle or wait out the refund.
4. Issue a new key (fresh device or derivation branch) for new escrows only.
5. Write an incident note: what was exposed, when, which escrows, what was done.
   On mainnet, also talk to counsel about notice duties before saying anything
   publicly.

## Why

Two of three keys release funds, so a stolen verifier key plus one colluding
party can pay out early or claw back. Keeping the co-signing key offline and
per-escrow limits that to one escrow at a time, and keeping it off servers
keeps Stimuli Network from holding anything a regulator could read as control
of client funds (see `docs/compliance.md`).
