import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertFeesAllowed, LEGAL_GATES, mainnetAllowed } from "../src/compliance/gates.ts";
import { extractDigitalCurrencyAddresses, isoPublishDate } from "../src/compliance/sdn.ts";
import {
  BUNDLED_SDN_LIST, listAgeDays, loadBundledSdnList, MAX_LIST_AGE_DAYS, parseDenylist, parseSdnList, screenAddresses,
} from "../src/compliance/screening.ts";
import { encodeAddress, VERSION } from "../src/kaspa/address.ts";
import { verifierCosignDecision } from "../src/kaspa/policy.ts";
import { buildPayload } from "../src/proof.ts";

const addr = (n: number, prefix = "kaspa") => encodeAddress(prefix, VERSION.PubKey, new Uint8Array(32).fill(n));

test("legal gates are locked by default and frozen", () => {
  assert.equal(LEGAL_GATES.mainnetLegalReviewComplete, false);
  assert.equal(LEGAL_GATES.feesAttorneySignoff, false);
  assert.ok(Object.isFrozen(LEGAL_GATES));
  assert.throws(() => { (LEGAL_GATES as { feesAttorneySignoff: boolean }).feesAttorneySignoff = true; });
  assert.equal(mainnetAllowed(true), false);
  assert.equal(mainnetAllowed(false, { mainnetLegalReviewComplete: true, feesAttorneySignoff: false }), false);
  assert.equal(mainnetAllowed(true, { mainnetLegalReviewComplete: true, feesAttorneySignoff: false }), true);
  assert.throws(() => assertFeesAllowed(), /no fees during testnet\/beta/);
  assert.doesNotThrow(() => assertFeesAllowed({ mainnetLegalReviewComplete: false, feesAttorneySignoff: true }));
});

test("mainnet co-signing needs opt-in and the legal-review gate", () => {
  const C = addr(1), K = addr(2);
  const req = {
    network: "kaspa-mainnet" as const, specSha256: "ab".repeat(32), cosignWith: "contractor" as const,
    outputs: [{ address: C, amountSompi: 10n }], contractorAddress: C, clientAddress: K,
    proof: { valid: true, specSha256: "ab".repeat(32) },
  };
  assert.match(verifierCosignDecision(req, { allowMainnet: true }).reasons.join(), /mainnet co-signing is disabled/);
  assert.equal(verifierCosignDecision(req, { allowMainnet: true, gates: { mainnetLegalReviewComplete: true, feesAttorneySignoff: false } }).allow, true);
});

test("an operator fee output is refused even with the fee gate set", () => {
  const C = addr(1, "kaspatest"), K = addr(2, "kaspatest"), S = addr(3, "kaspatest");
  const d = verifierCosignDecision({
    network: "kaspa-testnet-10", specSha256: "ab".repeat(32), cosignWith: "contractor",
    outputs: [{ address: C, amountSompi: 95n }, { address: S, amountSompi: 5n }], contractorAddress: C, clientAddress: K,
    proof: { valid: true, specSha256: "ab".repeat(32) },
  }, { operatorAddresses: [S], gates: { mainnetLegalReviewComplete: true, feesAttorneySignoff: true } });
  assert.equal(d.allow, false);
  assert.match(d.reasons.join(), /fees are never taken from escrow/);
});

test("the verifier refuses to sign a proof for a mainnet payout", () => {
  const spec = {
    schema: "stimuli.milestone/v1", id: "m1", title: "t", repo: "o/r", contractor: { github: "c" }, client: { name: "x" },
    payout: { amountSompi: "1", network: "kaspa-mainnet" as const }, criteria: [],
  } as unknown as Parameters<typeof buildPayload>[0];
  assert.throws(() => buildPayload(spec, "a".repeat(40), [], "pk"), /mainnet payout/);
});

const SAMPLE_XML = `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>11/20/2026</Publish_Date><Record_Count>3</Record_Count></publshInformation>
  <sdnEntry><uid>1</uid><lastName>NO ADDRESSES &amp; CO</lastName><idList><id><uid>9</uid><idType>Passport</idType><idNumber>X1</idNumber></id></idList></sdnEntry>
  <sdnEntry><uid>2</uid><firstName>Jane</firstName><lastName>DOE</lastName><idList>
    <id><uid>10</uid><idType>Digital Currency Address - XBT</idType><idNumber>1AbcDEF</idNumber></id>
    <id><uid>11</uid><idType>Digital Currency Address - ETH</idType><idNumber> 0xAbC </idNumber></id>
    <id><uid>12</uid><idType>Digital Currency Address - XBT</idType><idNumber>1AbcDEF</idNumber></id>
  </idList></sdnEntry>
  <sdnEntry><uid>3</uid><lastName>KAS EXAMPLE</lastName><idList><id><uid>13</uid><idType>Digital Currency Address - KAS</idType><idNumber>kaspa:qexample</idNumber></id></idList></sdnEntry>
</sdnList>`;

test("SDN XML extraction keeps every chain, dedupes, and records provenance", () => {
  const l = extractDigitalCurrencyAddresses(SAMPLE_XML, { source: "test", sourceSha256: "0".repeat(64), generatedAt: "2026-11-23T00:00:00Z" });
  assert.equal(l.publishDate, "2026-11-20");
  assert.equal(l.sdnEntryCount, 3);
  assert.equal(l.addressCount, 3);
  assert.deepEqual(l.byCurrency, { ETH: 1, KAS: 1, XBT: 1 });
  assert.deepEqual(l.addresses.find((a) => a.currency === "ETH"), { address: "0xAbC", currency: "ETH", sdnUid: "2", name: "Jane DOE" });
  const deny = parseDenylist(JSON.stringify(l));
  assert.deepEqual(screenAddresses(["0xabc", "KASPA:QEXAMPLE", "1abcdef", "clean"], deny).hits.sort(), ["0xabc", "1abcdef", "kaspa:qexample"]);
  assert.throws(() => isoPublishDate("2026-11-20"), /Publish_Date/);
});

test("bundled OFAC list is populated, well formed, and ages out", () => {
  const raw = parseSdnList(readFileSync(BUNDLED_SDN_LIST, "utf8"));
  assert.match(raw.source, /^https:\/\/sanctionslistservice\.ofac\.treas\.gov\//);
  assert.equal(raw.addressCount, raw.addresses.length);
  const b = loadBundledSdnList();
  assert.ok(b.denylist.size > 500, `expected a populated list, got ${b.denylist.size}`);
  assert.ok((b.byCurrency.XBT ?? 0) > 0 && (b.byCurrency.ETH ?? 0) > 0);
  const listed = raw.addresses[0]!.address;
  assert.equal(screenAddresses([listed], b.denylist).hits.length, 1);
  const stale = Date.parse(`${b.publishDate}T00:00:00Z`) + (MAX_LIST_AGE_DAYS + 1) * 86_400_000;
  assert.ok(listAgeDays(b.publishDate, stale) > MAX_LIST_AGE_DAYS);
});
