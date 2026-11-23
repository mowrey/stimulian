import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "./canonical.ts";
import type { CriterionResult } from "./criteria.ts";
import { specHash, type MilestoneSpec } from "./spec.ts";
import { mainnetAllowed, MAINNET_REFUSED, type LegalGates } from "./compliance/gates.ts";

export const PROOF_SCHEMA = "stimuli.proof/v1";

export interface ProofPayload {
  schema: typeof PROOF_SCHEMA;
  milestoneId: string;
  specSha256: string;
  repo: string;
  commit: string;
  contractor: string;
  payout: MilestoneSpec["payout"];
  results: CriterionResult[];
  passed: boolean;
  verifiedAt: string;
  verifierPublicKey: string; // Ed25519 SPKI, base64
}

export interface MilestoneProof {
  payload: ProofPayload;
  digest: string; // sha256 of canonical payload, hex: what an escrow oracle co-signs against
  signature: string; // Ed25519 over the canonical payload, base64
}

export function generateVerifierKey(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: exportPublic(publicKey),
  };
}

function exportPublic(k: KeyObject): string {
  return (k.export({ type: "spki", format: "der" }) as Buffer).toString("base64");
}

function importPublic(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

export function buildPayload(
  spec: MilestoneSpec, commit: string, results: CriterionResult[], publicKey: string, now = new Date(),
  opts: { allowMainnet?: boolean; gates?: LegalGates } = {},
): ProofPayload {
  // The verifier does not sign proofs for mainnet payouts until legal review.
  if (spec.payout.network === "kaspa-mainnet" && !mainnetAllowed(opts.allowMainnet, opts.gates)) {
    throw new Error(`refusing to sign a proof for a mainnet payout: ${MAINNET_REFUSED}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("commit must be a full 40-character SHA");
  const ids = new Set(results.map((r) => r.id));
  const missing = spec.criteria.filter((c) => !ids.has(c.id)).map((c) => c.id);
  if (missing.length) throw new Error(`results missing for criteria: ${missing.join(", ")}`);
  return {
    schema: PROOF_SCHEMA,
    milestoneId: spec.id,
    specSha256: specHash(spec),
    repo: spec.repo,
    commit,
    contractor: spec.contractor.github,
    payout: spec.payout,
    results,
    passed: results.every((r) => r.passed),
    verifiedAt: now.toISOString(),
    verifierPublicKey: publicKey,
  };
}

export function signProof(payload: ProofPayload, privatePem: string): MilestoneProof {
  const key = createPrivateKey(privatePem);
  if (exportPublic(createPublicKey(key)) !== payload.verifierPublicKey) throw new Error("private key does not match verifierPublicKey");
  const msg = Buffer.from(canonicalJson(payload));
  return {
    payload,
    digest: createHash("sha256").update(msg).digest("hex"),
    signature: sign(null, msg, key).toString("base64"),
  };
}

export interface ProofCheck { valid: boolean; reasons: string[] }

// Everything a client, contractor, or escrow oracle must check before trusting a proof.
export function verifyProof(proof: MilestoneProof, opts: { spec?: MilestoneSpec; trustedKeys?: string[] } = {}): ProofCheck {
  const reasons: string[] = [];
  const p = proof?.payload;
  if (!p || p.schema !== PROOF_SCHEMA) return { valid: false, reasons: ["not a stimuli.proof/v1 document"] };
  const msg = Buffer.from(canonicalJson(p));
  if (createHash("sha256").update(msg).digest("hex") !== proof.digest) reasons.push("digest does not match payload");
  try {
    if (!verify(null, msg, importPublic(p.verifierPublicKey), Buffer.from(proof.signature, "base64"))) reasons.push("signature is invalid");
  } catch {
    reasons.push("signature or public key is malformed");
  }
  if (opts.trustedKeys && !opts.trustedKeys.includes(p.verifierPublicKey)) reasons.push("verifier key is not trusted");
  if (!p.passed || !p.results.every((r) => r.passed)) reasons.push("milestone did not pass every criterion");
  if (opts.spec) {
    if (specHash(opts.spec) !== p.specSha256) reasons.push("proof is for a different milestone spec");
    const ids = new Set(p.results.map((r) => r.id));
    for (const c of opts.spec.criteria) if (!ids.has(c.id)) reasons.push(`criterion ${c.id} has no result`);
  }
  return { valid: reasons.length === 0, reasons };
}
