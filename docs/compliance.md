# Compliance design notes

These notes explain the design choices in this repository that exist for
regulatory reasons. They are engineering notes, not legal advice. Client work is
billed in US dollars; everything escrow-related here runs on Kaspa testnet only.

## Non-custodial escrow

The goal is that no Stimuli Network key can move a client's funds on its own,
and that no Stimuli Network key can stop a client from getting unreleased funds
back. FinCEN's 2019 guidance describes a multiple-signature wallet provider that
only adds a second authorization key, without hosting the wallet or holding
independent control of the value, as not a money transmitter
([FIN-2019-G001, section 4.2.2](https://www.fincen.gov/system/files/2019-05/FinCEN%20Guidance%20CVC%20FINAL%20508.pdf)).
Minnesota's money transmission law defines control of virtual currency as the
power to "execute unilaterally or prevent indefinitely" a transaction
([Minn. Stat. 53B.69](https://www.revisor.mn.gov/statutes/cite/53B.69)). How
those rules apply to this design is a question for counsel; the code keeps the
facts that analysis depends on true:

| Invariant | Where it is enforced |
| --- | --- |
| No single key can release funds (2 of client, contractor, verifier) | redeem script, `src/kaspa/escrow.ts` |
| Client + contractor can always settle without the verifier | redeem script |
| Client alone recovers funds after the refund deadline | redeem script (`OP_CHECKLOCKTIMEVERIFY` branch) |
| Refund deadline is in the future, at most two years out (warned past one year, and under one day) | `checkRefundLockTime` |
| Three distinct keys | `buildRedeemScript` |
| Mainnet refused unless explicitly allowed **and** the legal-review gate is set (it is not; the CLI never opts in) | `LEGAL_GATES` in `src/compliance/gates.ts`, `buildEscrow`, `buildPayload`, `verifierCosignDecision` |
| Verifier co-signs only a proof-backed release to the contractor, or a release under a signed dispute resolution | `verifierCosignDecision`, `src/kaspa/policy.ts` |
| Escrow never pays the verifier or Stimuli Network (no fee outputs), whatever the fee gate says | `verifierCosignDecision`, `PLATFORM_FEE_FROM_ESCROW = false` |
| No fee code runs until an attorney signs off (gate is false) | `assertFeesAllowed`, `LEGAL_GATES.feesAttorneySignoff` |
| Every co-signature is screened against OFAC's SDN address list, refused if the list is over 30 days old | `cosign-check`, `data/ofac-sdn-digital-currency-addresses.json` |
| Verifier never holds client or contractor keys | by construction: it only ever signs with its own key |

### Why the verifier needs a policy

Two of three keys release funds, so the verifier plus one other party can move
them. Contractor + verifier could pay out before delivery; client + verifier
could pull funds back before the deadline. Both are the verifier casting the
deciding vote. `verifierCosignDecision` is the check a verifier runs before it
signs:

- with the contractor: needs a valid proof for the exact spec hash the escrow is
  bound to, and pays only the agreed contractor address (change may go to the
  agreed client address);
- with the client: needs the id of a written dispute resolution both parties
  signed; otherwise the client waits for the timelocked refund, which needs no
  one else;
- never pays an operator address, never runs on mainnet, and refuses any
  address on the OFAC SDN list (bundled) or an extra denylist.

Try it with `node src/cli.ts cosign-check --request cosign.json --operator <stimuli address> [--denylist extra.txt]`.

## Legal gates

`src/compliance/gates.ts` holds two flags, both `false`:

- `mainnetLegalReviewComplete`: mainnet escrow building, proof signing and
  co-signing stay refused until a written legal review approves mainnet.
- `feesAttorneySignoff`: no fee code path may run until a Minnesota
  fintech / money-transmission attorney signs off in writing on a specific fee
  model. There are no fees during testnet/beta.

They are code constants on purpose: no environment variable or CLI flag can
flip them. Changing one takes a reviewed pull request that links the written
sign-off and updates this file. The Stimuli Network API has matching flags that
refuse to start if set, because the API has no mainnet or fee support at all.

## Verifier keys

See [key-custody.md](key-custody.md): per-environment, rotated testnet keys;
for mainnet, a hardware-backed key held offline by Adrian, never on a server,
with per-escrow derived keys and a rotation and compromise procedure.

### Fees

Decision (2026-11-23): **no fees at all during testnet/beta.** Fees are never
taken as an escrow output, even after an attorney signs off: any future fee is
invoiced separately from the escrow, so the escrow only ever moves value from
client to contractor (or back to the client). The verifier policy refuses an
operator output unconditionally, and `assertFeesAllowed` keeps any fee code
path off until `LEGAL_GATES.feesAttorneySignoff` is set after written sign-off.
Whether any fee model changes the money transmission analysis is a question for
counsel before mainnet.

### Refund timelock edge cases

- Too early: a deadline in the past lets the client take funded escrow back at
  any moment, so it is refused; under a day is flagged.
- Too late: past two years is refused, because the refund path is what keeps
  funds from being stuck if the other parties stop cooperating.
- DAA-score deadlines: checked only when a current DAA score is supplied
  (`--current-daa`), converted at about 10 DAA per second (Crescendo, KIP-14).
  Prefer date deadlines.
- Fees and dust: keep escrow amounts well above dust. Kaspa's storage mass
  (KIP-9) makes very small outputs expensive to create, which can make a tiny
  refund or release costly to broadcast.

## Sanctions screening

OFAC sanctions apply to virtual currency the same way as to fiat, and OFAC asks
technology and wallet providers to screen from the testing stage on
([OFAC guidance for the virtual currency industry, 2021](https://ofac.treasury.gov/media/913571/download)).
`src/compliance/screening.ts` checks addresses against OFAC's SDN digital
currency addresses, bundled in `data/` and refreshed by hand with
`scripts/update-ofac-sdn.ts` (free official source, no vendor). See
[sanctions-screening.md](sanctions-screening.md) for the refresh procedure, the
30-day fail-closed rule, the sign-up self-attestation in the app, and what is
still missing before mainnet (IP geoblocking, onboarding name screening).

## Before any mainnet, real funds or fees

A consult with a Minnesota fintech / money-transmission attorney is a hard gate
before mainnet, real funds, or any fee. Until then both legal gates stay false.

## Not in this repository

Worker classification, tax forms, contract terms, age requirements and privacy
are handled in the Stimuli Network app and its agreement templates, not in the
protocol tooling.
