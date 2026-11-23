# Sanctions screening: OFAC SDN address list

Not legal advice. Decided by Adrian Mowrey on 2026-11-23: use OFAC's free,
official SDN list; no paid vendor and no paid scheduled infrastructure.

## What is screened

`stimulian cosign-check` always screens every party and output address against
`data/ofac-sdn-digital-currency-addresses.json`, plus any extra list given with
`--denylist`. A hit refuses the co-signature.

The bundled file is built from OFAC's SDN list (Sanctions List Service,
https://sanctionslist.ofac.treas.gov/, XML export
`https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML`).
It keeps **every** identifier whose type starts with `Digital Currency Address - `,
for all chains (XBT, ETH, TRX, USDT, LTC, XMR and the rest). As of the SDN list
published 2026-11-20 there were 1,078 addresses and none for Kaspa (`KAS`); if
OFAC lists Kaspa addresses they are picked up automatically. The file records
the source URL, OFAC's publish date, the SHA-256 of the XML it was built from,
and a count per currency.

Matching is case-insensitive. Bitcoin-style addresses are case-sensitive, so
this can only add false positives, never miss a listed address.

## Freshness (fail closed)

- `stimulian sdn-status` prints the list's publish date and age.
- `cosign-check` warns when the list is more than 7 days old and **refuses to
  allow a co-signature when it is more than 30 days old**.

## Refresh procedure (manual)

At least weekly while anyone is co-signing, and always before a co-signing
session:

```bash
node scripts/update-ofac-sdn.ts          # or: npm run sdn:update
git diff --stat data/                    # review the change in counts
npm test
```

Then commit on a branch and open a pull request titled
`Refresh OFAC SDN address list (published YYYY-MM-DD)`. If OFAC's download
fails, download the SDN XML from https://sanctionslist.ofac.treas.gov/ in a
browser and run `node scripts/update-ofac-sdn.ts --file SDN.XML`. The script
refuses to write an empty list. OFAC's recent actions page
(https://ofac.treasury.gov/recent-actions) shows when the list changed.

## What this does not cover (mainnet prerequisites)

- **People and places at sign-up:** the Stimuli Network app asks every account
  holder to confirm they are 18+, not on the SDN list, not owned or controlled by
  someone who is, and not located in, or ordinarily resident in, a comprehensively
  sanctioned jurisdiction: Cuba, Iran, North Korea, Syria, and the Crimea,
  so-called Donetsk People's Republic and Luhansk People's Republic regions of
  Ukraine. The API refuses writes until that is confirmed. This is a
  self-attestation, not verification.
- **IP geoblocking** is not built: Render's free plan offers no geo-IP filtering.
  It is a mainnet prerequisite, along with name screening against the SDN list at
  onboarding, a review process for hits, and five-year records.
- Whether this is a proportionate program for a non-custodial co-signer is one of
  the questions for a Minnesota attorney before mainnet.
