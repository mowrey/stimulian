import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAddress, VERSION } from "../src/kaspa/address.ts";
import { PLATFORM_FEE_FROM_ESCROW, verifierCosignDecision, type CosignRequest } from "../src/kaspa/policy.ts";
import { parseDenylist, screenAddresses } from "../src/compliance/screening.ts";

const addr = (n: number, prefix = "kaspatest") => encodeAddress(prefix, VERSION.PubKey, new Uint8Array(32).fill(n));
const CONTRACTOR = addr(1);
const CLIENT = addr(2);
const STIMULI = addr(3);
const STRANGER = addr(4);
const SPEC = "ab".repeat(32);

const release = (over: Partial<CosignRequest> = {}): CosignRequest => ({
  network: "kaspa-testnet-10",
  specSha256: SPEC,
  cosignWith: "contractor",
  outputs: [{ address: CONTRACTOR, amountSompi: 100_000_000n }],
  contractorAddress: CONTRACTOR,
  clientAddress: CLIENT,
  proof: { valid: true, specSha256: SPEC },
  ...over,
});

test("proof-backed release to the contractor is allowed", () => {
  assert.deepEqual(verifierCosignDecision(release()), { allow: true, reasons: [] });
  // change back to the client is fine
  const d = verifierCosignDecision(release({ outputs: [{ address: CONTRACTOR, amountSompi: 5n }, { address: CLIENT, amountSompi: 5n }] }));
  assert.equal(d.allow, true);
});

test("contractor release needs a valid proof for the bound spec", () => {
  assert.match(verifierCosignDecision(release({ proof: undefined })).reasons.join(), /valid milestone proof/);
  assert.match(verifierCosignDecision(release({ proof: { valid: false, specSha256: SPEC } })).reasons.join(), /valid milestone proof/);
  assert.match(verifierCosignDecision(release({ proof: { valid: true, specSha256: "cd".repeat(32) } })).reasons.join(), /different spec/);
  assert.match(verifierCosignDecision(release({ outputs: [{ address: CLIENT, amountSompi: 5n }] })).reasons.join(), /must pay the contractor/);
});

test("never pays an operator or a stranger from escrow", () => {
  assert.equal(PLATFORM_FEE_FROM_ESCROW, false);
  const fee = verifierCosignDecision(
    release({ outputs: [{ address: CONTRACTOR, amountSompi: 95n }, { address: STIMULI, amountSompi: 5n }] }),
    { operatorAddresses: [STIMULI] },
  );
  assert.equal(fee.allow, false);
  assert.match(fee.reasons.join(), /fees are never taken from escrow/);
  const other = verifierCosignDecision(release({ outputs: [{ address: CONTRACTOR, amountSompi: 95n }, { address: STRANGER, amountSompi: 5n }] }));
  assert.match(other.reasons.join(), /neither the agreed contractor nor client/);
  const asParty = verifierCosignDecision(release({ contractorAddress: STIMULI, outputs: [{ address: STIMULI, amountSompi: 5n }] }), { operatorAddresses: [STIMULI] });
  assert.match(asParty.reasons.join(), /operator address is listed as a party/);
});

test("client + verifier needs a signed dispute resolution", () => {
  const early = verifierCosignDecision(release({ cosignWith: "client", proof: undefined, outputs: [{ address: CLIENT, amountSompi: 5n }] }));
  assert.equal(early.allow, false);
  assert.match(early.reasons.join(), /dispute resolution/);
  const ruled = verifierCosignDecision(release({
    cosignWith: "client", proof: undefined, disputeResolutionId: "DR-1",
    outputs: [{ address: CLIENT, amountSompi: 3n }, { address: CONTRACTOR, amountSompi: 2n }],
  }));
  assert.deepEqual(ruled, { allow: true, reasons: [] });
});

test("mainnet, wrong-network and malformed addresses are refused", () => {
  const main = verifierCosignDecision(release({ network: "kaspa-mainnet" }));
  assert.match(main.reasons.join(), /mainnet co-signing is disabled/);
  const wrongNet = verifierCosignDecision(release({ outputs: [{ address: addr(1, "kaspa"), amountSompi: 5n }] }));
  assert.match(wrongNet.reasons.join(), /not a kaspa-testnet-10 address/);
  const bad = verifierCosignDecision(release({ contractorAddress: "kaspatest:nope" }));
  assert.match(bad.reasons.join(), /not a valid Kaspa address/);
  assert.match(verifierCosignDecision(release({ outputs: [] })).reasons.join(), /no outputs/);
  assert.match(verifierCosignDecision(release({ outputs: [{ address: CONTRACTOR, amountSompi: 0n }] })).reasons.join(), /positive/);
});

test("sanctions denylist hook", () => {
  const list = parseDenylist(`# test list\n${CONTRACTOR.toUpperCase()}\n\n`);
  assert.equal(list.size, 1);
  assert.deepEqual(parseDenylist(JSON.stringify([STRANGER])), new Set([STRANGER]));
  assert.deepEqual(parseDenylist(""), new Set());
  assert.throws(() => parseDenylist("[1]"), /array of strings/);
  assert.deepEqual(screenAddresses([CONTRACTOR, CLIENT, CONTRACTOR], list), { screened: 2, hits: [CONTRACTOR], listSize: 1 });
  const d = verifierCosignDecision(release(), { denylist: list });
  assert.equal(d.allow, false);
  assert.match(d.reasons.join(), /sanctions screening hit/);
});
