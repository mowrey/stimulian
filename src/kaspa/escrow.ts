// Non-custodial milestone escrow for Kaspa (P2SH).
//
// Redeem script:
//   <specSha256> OP_DROP                       binds the address to one milestone spec
//   OP_IF
//     OP_2 <client> <contractor> <verifier> OP_3 OP_CHECKMULTISIG
//   OP_ELSE
//     <refundLockTime> OP_CHECKLOCKTIMEVERIFY <client> OP_CHECKSIG
//   OP_ENDIF
//
// Release: any two of client, contractor, verifier sign. Normally contractor +
//   verifier after a valid milestone proof; client + contractor can always
//   settle a dispute between themselves.
// Refund: once the lock time passes, the client alone recovers the funds.
// No single party, Stimuli Network's verifier included, can move funds alone.
// The verifier plus one other party can, so the verifier only co-signs what
// its policy allows (src/kaspa/policy.ts): a proof-backed release to the
// contractor, or a signed dispute resolution. It is never paid from escrow.
//
// Kaspa specifics (rusty-kaspa crypto/txscript): keys are 32-byte x-only
// Schnorr keys; OP_CHECKMULTISIG takes signatures in key order with no dummy
// element; OP_CHECKLOCKTIMEVERIFY pops its operand; lock times below
// 500,000,000,000 are DAA scores, at or above it are Unix milliseconds.
import { blake2b } from "./blake2b.ts";
import { encodeAddress, PREFIX, VERSION, type Network } from "./address.ts";
import { disassemble, hex, OP, ScriptBuilder } from "./script.ts";

export const LOCK_TIME_THRESHOLD = 500_000_000_000n;

export interface EscrowParams {
  specSha256: string;
  clientPubKey: string;     // 32-byte x-only Schnorr key, hex
  contractorPubKey: string;
  verifierPubKey: string;
  refundLockTime: bigint;   // DAA score (< threshold) or Unix ms (>= threshold)
  network: Network;
  // Mainnet is refused unless the caller opts in explicitly. Stimuli Network
  // tooling is testnet-only until legal review; tests use this to check
  // address encoding only.
  allowMainnet?: boolean;
}

export interface Escrow {
  network: Network;
  address: string;
  redeemScript: string;        // hex
  scriptPublicKey: string;     // hex, version 0
  asm: string;
  refundLockTime: string;
  refundLockTimeKind: "daa-score" | "unix-ms";
}

function key(name: string, h: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error(`${name} must be a 32-byte x-only public key in hex`);
  return hex.from(h.toLowerCase());
}

export function buildRedeemScript(p: EscrowParams): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(p.specSha256)) throw new Error("specSha256 must be 64 lowercase hex chars");
  const client = key("clientPubKey", p.clientPubKey);
  const contractor = key("contractorPubKey", p.contractorPubKey);
  const verifier = key("verifierPubKey", p.verifierPubKey);
  if (new Set([p.clientPubKey, p.contractorPubKey, p.verifierPubKey].map((k) => k.toLowerCase())).size !== 3) {
    throw new Error("client, contractor and verifier keys must all differ");
  }
  if (p.refundLockTime <= 0n) throw new Error("refundLockTime must be positive");
  return new ScriptBuilder()
    .addData(hex.from(p.specSha256)).addOp(OP.OP_DROP)
    .addOp(OP.OP_IF)
      .addSmallInt(2).addData(client).addData(contractor).addData(verifier).addSmallInt(3).addOp(OP.OP_CHECKMULTISIG)
    .addOp(OP.OP_ELSE)
      .addLockTime(p.refundLockTime).addOp(OP.OP_CHECKLOCKTIMEVERIFY).addData(client).addOp(OP.OP_CHECKSIG)
    .addOp(OP.OP_ENDIF)
    .build();
}

export function p2shScriptPublicKey(redeemScript: Uint8Array): Uint8Array {
  return new ScriptBuilder().addOp(OP.OP_BLAKE2B).addData(blake2b(redeemScript, 32)).addOp(OP.OP_EQUAL).build();
}

export function buildEscrow(p: EscrowParams): Escrow {
  if (p.network === "kaspa-mainnet" && !p.allowMainnet) {
    throw new Error("mainnet escrow is disabled: Stimuli Network tooling is testnet-only until legal review");
  }
  const redeem = buildRedeemScript(p);
  return {
    network: p.network,
    address: encodeAddress(PREFIX[p.network], VERSION.ScriptHash, blake2b(redeem, 32)),
    redeemScript: hex.to(redeem),
    scriptPublicKey: hex.to(p2shScriptPublicKey(redeem)),
    asm: disassemble(redeem),
    refundLockTime: p.refundLockTime.toString(),
    refundLockTimeKind: p.refundLockTime < LOCK_TIME_THRESHOLD ? "daa-score" : "unix-ms",
  };
}

// Signature scripts. Each signature is 64-byte Schnorr + 1 sighash-type byte (65 bytes, hex).
function sig(h: string): Uint8Array {
  const b = hex.from(h);
  if (b.length !== 65) throw new Error("signature must be 65 bytes (64-byte Schnorr + sighash type)");
  return b;
}

const ORDER = ["client", "contractor", "verifier"] as const;
export type Signer = (typeof ORDER)[number];

// Two signatures from different parties; sorted into the key order the script expects.
export function releaseSignatureScript(redeemScriptHex: string, sigs: Partial<Record<Signer, string>>): string {
  const present = ORDER.filter((who) => sigs[who]);
  if (present.length !== 2) throw new Error("release needs exactly two signatures from different parties");
  const b = new ScriptBuilder();
  for (const who of present) b.addData(sig(sigs[who]!));
  b.addOp(OP.OP_1).addData(hex.from(redeemScriptHex));
  return hex.to(b.build());
}

export function refundSignatureScript(redeemScriptHex: string, clientSig: string): string {
  return hex.to(new ScriptBuilder().addData(sig(clientSig)).addOp(OP.OP_0).addData(hex.from(redeemScriptHex)).build());
}

// Refund deadline bounds. The timelocked client refund is load-bearing: it is
// what keeps the verifier (or anyone else) from blocking the client's funds
// indefinitely, so the deadline must be real, reachable and not absurdly far.
//   - in the past (or now): refused. The client could reclaim funded escrow at
//     any moment, removing the contractor's protection.
//   - more than REFUND_MAX_MS away: refused. Funds would sit out of the
//     client's reach for years if the other parties stop cooperating.
//   - more than REFUND_WARN_AFTER_MS away: allowed, flagged.
//   - less than REFUND_MIN_LEAD_MS away: allowed, flagged (the contractor has
//     almost no protected window to deliver).
// DAA-score deadlines can only be judged against a current DAA score. Pass one
// (from a node) to apply the same bounds; without it the deadline is flagged
// as unchecked. Conversion uses Kaspa's 10 blocks per second (Crescendo,
// KIP-14), so it is an estimate: DAA score advances at about 10 per second.
const DAY_MS = 24n * 60n * 60n * 1000n;
export const REFUND_MIN_LEAD_MS = DAY_MS;
export const REFUND_WARN_AFTER_MS = 365n * DAY_MS;
export const REFUND_MAX_MS = 2n * 365n * DAY_MS;
export const DAA_SCORE_PER_SECOND = 10n;

export function checkRefundLockTime(
  lockTime: bigint,
  nowMs: bigint = BigInt(Date.now()),
  currentDaaScore?: bigint,
): string[] {
  if (lockTime <= 0n) throw new Error("refund lock time must be positive");
  let leadMs: bigint;
  if (lockTime >= LOCK_TIME_THRESHOLD) {
    leadMs = lockTime - nowMs;
  } else {
    if (currentDaaScore === undefined) {
      return ["refund deadline is a DAA score and was not checked; pass the current DAA score (--current-daa) to check it"];
    }
    leadMs = ((lockTime - currentDaaScore) * 1000n) / DAA_SCORE_PER_SECOND;
  }
  if (leadMs <= 0n) throw new Error("refund deadline is already in the past; pick a future date");
  if (leadMs > REFUND_MAX_MS) {
    throw new Error("refund deadline is more than two years away; the client's refund path must stay reachable");
  }
  const warnings: string[] = [];
  if (leadMs > REFUND_WARN_AFTER_MS) warnings.push("refund deadline is more than a year away; the client cannot reclaim unreleased funds before then");
  if (leadMs < REFUND_MIN_LEAD_MS) warnings.push("refund deadline is less than a day away; the contractor has almost no protected time to deliver");
  return warnings;
}

// "2026-12-31" / ISO timestamp -> Unix ms; plain integer -> DAA score.
export function parseLockTime(s: string): bigint {
  if (/^\d+$/.test(s)) return BigInt(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new Error(`cannot parse lock time "${s}"`);
  const v = BigInt(ms);
  if (v < LOCK_TIME_THRESHOLD) throw new Error("date is too early to be a Kaspa timestamp lock time");
  return v;
}
