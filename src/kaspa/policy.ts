// Verifier co-signing policy.
//
// The escrow script lets any two of client, contractor and verifier release
// funds. That means the verifier plus ONE other party can move them, so the
// verifier's own rules are what stop it from being the deciding vote in an
// unfair release. This module is the check a verifier runs before it signs.
//
// Invariants (see docs/compliance.md):
//   1. Contractor + verifier: only after a valid milestone proof for the exact
//      spec the escrow is bound to, and only paying the agreed contractor
//      address (change may return to the agreed client address).
//   2. Client + verifier: only under a written dispute resolution both parties
//      signed (an id is required), paying only the agreed client and/or
//      contractor addresses. Otherwise the client waits for the timelocked
//      refund, which needs no one else.
//   3. Never pay the verifier, Stimuli Network, or any other operator address
//      from escrow. Fees, if ever charged, are invoiced separately; taking
//      them as an escrow output would make the operator a recipient of the
//      client's funds (an attorney question before any mainnet fees). This
//      holds even if the fee gate in src/compliance/gates.ts is ever set:
//      no fees during testnet/beta, and any future fee is a separate invoice.
//   4. Never co-sign on mainnet unless explicitly allowed AND the legal-review
//      gate in src/compliance/gates.ts is set (it is false: testnet-only).
//   5. Refuse if any party or output address is on the operator's sanctions
//      denylist (src/compliance/screening.ts).
// The verifier never needs, and must never hold, the client's or contractor's
// private keys.
import { decodeAddress, PREFIX, type Network } from "./address.ts";
import { normalizeAddress, screenAddresses } from "../compliance/screening.ts";
import { mainnetAllowed, type LegalGates } from "../compliance/gates.ts";

export const PLATFORM_FEE_FROM_ESCROW = false as const;

export interface TxOutput {
  address: string;
  amountSompi: bigint;
}

export interface CosignRequest {
  network: Network;
  specSha256: string;            // the spec the escrow script is bound to
  cosignWith: "contractor" | "client";
  outputs: TxOutput[];
  contractorAddress: string;     // agreed payout address
  clientAddress?: string;        // agreed refund / change address
  proof?: { valid: boolean; specSha256: string };
  disputeResolutionId?: string;  // required for client + verifier
}

export interface CosignPolicy {
  operatorAddresses?: Iterable<string>; // verifier / Stimuli addresses: never paid from escrow
  denylist?: ReadonlySet<string>;
  allowMainnet?: boolean;
  gates?: LegalGates;                   // defaults to LEGAL_GATES (mainnet locked)
}

export interface CosignDecision {
  allow: boolean;
  reasons: string[];
}

function checkAddress(a: string, network: Network, label: string, reasons: string[]): void {
  try {
    const d = decodeAddress(a);
    if (d.prefix !== PREFIX[network]) reasons.push(`${label} ${a} is not a ${network} address`);
  } catch (e) {
    reasons.push(`${label} ${a} is not a valid Kaspa address (${(e as Error).message})`);
  }
}

export function verifierCosignDecision(req: CosignRequest, policy: CosignPolicy = {}): CosignDecision {
  const reasons: string[] = [];
  if (req.network === "kaspa-mainnet" && !mainnetAllowed(policy.allowMainnet, policy.gates)) reasons.push("mainnet co-signing is disabled (testnet-only until legal review)");
  if (!/^[0-9a-f]{64}$/.test(req.specSha256)) reasons.push("specSha256 must be 64 lowercase hex chars");
  if (req.outputs.length === 0) reasons.push("transaction has no outputs");

  checkAddress(req.contractorAddress, req.network, "contractor address", reasons);
  if (req.clientAddress) checkAddress(req.clientAddress, req.network, "client address", reasons);
  const contractor = normalizeAddress(req.contractorAddress);
  const client = req.clientAddress ? normalizeAddress(req.clientAddress) : undefined;
  const operators = new Set([...(policy.operatorAddresses ?? [])].map(normalizeAddress));
  if (operators.has(contractor) || (client && operators.has(client))) reasons.push("an operator address is listed as a party address");

  for (const [i, o] of req.outputs.entries()) {
    checkAddress(o.address, req.network, `output ${i}`, reasons);
    if (o.amountSompi <= 0n) reasons.push(`output ${i} amount must be positive`);
    const a = normalizeAddress(o.address);
    if (operators.has(a)) reasons.push(`output ${i} pays an operator address; fees are never taken from escrow`);
    else if (a !== contractor && a !== client) reasons.push(`output ${i} pays ${o.address}, which is neither the agreed contractor nor client address`);
  }

  if (policy.denylist) {
    const r = screenAddresses([req.contractorAddress, req.clientAddress ?? "", ...req.outputs.map((o) => o.address)], policy.denylist);
    for (const h of r.hits) reasons.push(`sanctions screening hit: ${h}`);
  }

  if (req.cosignWith === "contractor") {
    if (!req.proof?.valid) reasons.push("contractor release needs a valid milestone proof");
    else if (req.proof.specSha256 !== req.specSha256) reasons.push("proof is for a different spec than the escrow is bound to");
    if (!req.outputs.some((o) => normalizeAddress(o.address) === contractor)) reasons.push("contractor release must pay the contractor address");
  } else if (req.cosignWith === "client") {
    if (!req.disputeResolutionId?.trim()) {
      reasons.push("client + verifier release needs a written dispute resolution signed by both parties; otherwise the client uses the timelocked refund");
    }
  } else {
    reasons.push("cosignWith must be contractor or client");
  }

  return { allow: reasons.length === 0, reasons };
}
