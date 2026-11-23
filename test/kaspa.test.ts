import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeAddress, encodeAddress, VERSION } from "../src/kaspa/address.ts";
import { blake2b } from "../src/kaspa/blake2b.ts";
import { buildEscrow, buildRedeemScript, LOCK_TIME_THRESHOLD, parseLockTime, refundSignatureScript, releaseSignatureScript } from "../src/kaspa/escrow.ts";
import { disassemble, hex, ScriptBuilder } from "../src/kaspa/script.ts";

test("blake2b matches RFC 7693 / Node's blake2b512", () => {
  const abc = new TextEncoder().encode("abc");
  assert.equal(hex.to(blake2b(abc, 64)), createHash("blake2b512").update("abc").digest("hex"));
  const long = new Uint8Array(1000).map((_, i) => i * 7);
  assert.equal(hex.to(blake2b(long, 64)), createHash("blake2b512").update(long).digest("hex"));
  assert.equal(hex.to(blake2b(new Uint8Array(0), 32)), "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
  assert.equal(hex.to(blake2b(new Uint8Array(128).fill(1), 32)).length, 64);
});

test("P2SH hash of a 2-of-4 multisig redeem script (BLAKE2b-256, cross-checked with Python hashlib)", () => {
  const redeem = hex.from(
    "5220ab64c7691713a32ea6dfced9155c5c26e8186426f0697af0db7a4b1340f992d12041ae738d66fe3d21105483e5851778ad73c5cddf0819c5e8fd8a589260d967e72065120722c36d3fac19646258481dd3661fa767da151304af514cb30af5cb5692203cd7690ecb67cbbe6cafad00a7c9133da535298ab164549e0cce2658f7b3032754ae",
  );
  assert.equal(hex.to(blake2b(redeem, 32)), "af7f68183a9c26f1901b4a6bd44dc94170bcd838ffe0715b67d59aab8c6817ea");
  assert.equal(hex.to(blake2b(new TextEncoder().encode("abc"), 32)), "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319");
  assert.match(disassemble(redeem), /^OP_2 (\w{64} ){4}OP_4 OP_CHECKMULTISIG$/);
});

test("address encoding matches rusty-kaspa vectors", () => {
  assert.equal(encodeAddress("kaspatest", VERSION.PubKey, new Uint8Array(32)), "kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya");
  assert.equal(encodeAddress("kaspa", VERSION.PubKey, new Uint8Array(32)), "kaspa:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkx9awp4e");
  assert.equal(encodeAddress("kaspatest", VERSION.PubKeyECDSA, new Uint8Array(33)), "kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d");
  const k = hex.from("ba01fc5f4e9d9879599c69a3dafdb835a7255e5f2e934e9322ecd3af190ab0f60e");
  const a = "kaspatest:qxaqrlzlf6wes72en3568khahq66wf27tuhfxn5nytkd8tcep2c0vrse6gdmpks";
  assert.equal(encodeAddress("kaspatest", VERSION.PubKeyECDSA, k), a);
  assert.deepEqual(decodeAddress(a), { prefix: "kaspatest", version: 1, payload: k });
  assert.throws(() => decodeAddress(a.slice(0, -1) + "q"), /checksum/);
});

test("script builder pushes canonically like rusty-kaspa", () => {
  assert.equal(hex.to(new ScriptBuilder().addData(Uint8Array.of(5)).build()), "55");
  assert.equal(hex.to(new ScriptBuilder().addData(new Uint8Array(0)).build()), "00");
  assert.equal(hex.to(new ScriptBuilder().addData(new Uint8Array(80)).build()).slice(0, 4), "4c50");
  assert.equal(hex.to(new ScriptBuilder().addLockTime(0x0100n).build()), "020001");
});

const K = { a: "11".repeat(32), b: "22".repeat(32), c: "33".repeat(32) };
const SPEC = "ab".repeat(32);
const params = { specSha256: SPEC, clientPubKey: K.a, contractorPubKey: K.b, verifierPubKey: K.c, refundLockTime: 123_456_789n, network: "kaspa-testnet-10" as const };

test("escrow script has the intended shape", () => {
  const e = buildEscrow(params);
  assert.equal(e.asm, `${SPEC} OP_DROP OP_IF OP_2 ${K.a} ${K.b} ${K.c} OP_3 OP_CHECKMULTISIG OP_ELSE 15cd5b07 OP_CHECKLOCKTIMEVERIFY ${K.a} OP_CHECKSIG OP_ENDIF`);
  assert.match(e.address, /^kaspatest:p/);
  assert.equal(e.scriptPublicKey, "aa20" + hex.to(blake2b(hex.from(e.redeemScript), 32)) + "87");
  assert.equal(decodeAddress(e.address).version, VERSION.ScriptHash);
  assert.equal(e.refundLockTimeKind, "daa-score");
});

test("escrow address changes with any term", () => {
  const base = buildEscrow(params).address;
  assert.notEqual(buildEscrow({ ...params, specSha256: "cd".repeat(32) }).address, base);
  assert.notEqual(buildEscrow({ ...params, refundLockTime: 123_456_790n }).address, base);
  assert.notEqual(buildEscrow({ ...params, contractorPubKey: "44".repeat(32) }).address, base);
  assert.notEqual(buildEscrow({ ...params, network: "kaspa-mainnet" }).address, base);
});

test("escrow rejects bad parameters", () => {
  assert.throws(() => buildRedeemScript({ ...params, verifierPubKey: K.a }), /must all differ/);
  assert.throws(() => buildRedeemScript({ ...params, clientPubKey: "02" + K.a }), /x-only/);
  assert.throws(() => buildRedeemScript({ ...params, specSha256: "xyz" }), /specSha256/);
});

test("signature scripts", () => {
  const e = buildEscrow(params);
  const s = (n: string) => n.repeat(65);
  const rel = releaseSignatureScript(e.redeemScript, { verifier: s("cc"), contractor: s("bb") });
  // contractor's signature must come before the verifier's (key order)
  assert.ok(rel.startsWith("41" + s("bb") + "41" + s("cc") + "51"));
  assert.throws(() => releaseSignatureScript(e.redeemScript, { client: s("aa") }), /exactly two/);
  const ref = refundSignatureScript(e.redeemScript, s("aa"));
  assert.ok(ref.startsWith("41" + s("aa") + "00"));
});

test("lock time parsing", () => {
  assert.equal(parseLockTime("98765"), 98765n);
  assert.ok(parseLockTime("2027-03-01T00:00:00Z") >= LOCK_TIME_THRESHOLD);
  assert.throws(() => parseLockTime("1970-01-02"), /too early/);
});
