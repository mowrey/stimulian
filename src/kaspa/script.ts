// Kaspa txscript building blocks, matching rusty-kaspa's ScriptBuilder
// (crypto/txscript/src/script_builder.rs): canonical data pushes, small ints as
// OP_n, lock times as trimmed little-endian bytes.
export const OP = {
  OP_0: 0x00, OP_PUSHDATA1: 0x4c, OP_PUSHDATA2: 0x4d, OP_PUSHDATA4: 0x4e, OP_1NEGATE: 0x4f,
  OP_1: 0x51, OP_2: 0x52, OP_3: 0x53, OP_16: 0x60,
  OP_IF: 0x63, OP_NOTIF: 0x64, OP_ELSE: 0x67, OP_ENDIF: 0x68, OP_VERIFY: 0x69,
  OP_DROP: 0x75, OP_DUP: 0x76, OP_EQUAL: 0x87, OP_EQUALVERIFY: 0x88,
  OP_BLAKE2B: 0xaa, OP_CHECKSIG: 0xac, OP_CHECKSIGVERIFY: 0xad,
  OP_CHECKMULTISIG: 0xae, OP_CHECKMULTISIGVERIFY: 0xaf,
  OP_CHECKLOCKTIMEVERIFY: 0xb0, OP_CHECKSEQUENCEVERIFY: 0xb1,
} as const;

const NAMES = new Map<number, string>(Object.entries(OP).map(([k, v]) => [v, k]));

export const hex = {
  from: (s: string): Uint8Array => {
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error(`invalid hex: ${s.slice(0, 16)}...`);
    return Uint8Array.from(Buffer.from(s, "hex"));
  },
  to: (b: Uint8Array): string => Buffer.from(b).toString("hex"),
};

export class ScriptBuilder {
  private bytes: number[] = [];

  addOp(op: number): this { this.bytes.push(op); return this; }

  addData(data: Uint8Array): this {
    const n = data.length;
    if (n === 0) return this.addOp(OP.OP_0);
    if (n === 1 && data[0] >= 1 && data[0] <= 16) return this.addOp(OP.OP_1 - 1 + data[0]);
    if (n === 1 && data[0] === 0x81) return this.addOp(OP.OP_1NEGATE);
    if (n <= 75) this.bytes.push(n);
    else if (n <= 0xff) this.bytes.push(OP.OP_PUSHDATA1, n);
    else if (n <= 0xffff) this.bytes.push(OP.OP_PUSHDATA2, n & 0xff, n >> 8);
    else this.bytes.push(OP.OP_PUSHDATA4, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
    this.bytes.push(...data);
    return this;
  }

  addSmallInt(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n > 16) throw new Error("addSmallInt: 0..16 only");
    return this.addOp(n === 0 ? OP.OP_0 : OP.OP_1 - 1 + n);
  }

  addLockTime(value: bigint): this {
    if (value < 0n || value >= 1n << 64n) throw new Error("lock time must fit in u64");
    const le: number[] = [];
    for (let v = value; v > 0n; v >>= 8n) le.push(Number(v & 0xffn));
    return this.addData(Uint8Array.from(le));
  }

  build(): Uint8Array { return Uint8Array.from(this.bytes); }
}

// Human-readable disassembly for audits and docs.
export function disassemble(script: Uint8Array): string {
  const out: string[] = [];
  for (let i = 0; i < script.length; ) {
    const op = script[i++];
    let len = -1;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === OP.OP_PUSHDATA1) len = script[i++];
    else if (op === OP.OP_PUSHDATA2) { len = script[i] | (script[i + 1] << 8); i += 2; }
    else if (op === OP.OP_PUSHDATA4) { len = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16)) + script[i + 3] * 2 ** 24; i += 4; }
    if (len >= 0) {
      if (i + len > script.length) throw new Error("malformed push");
      out.push(hex.to(script.subarray(i, i + len)));
      i += len;
    } else if (op > OP.OP_1 && op <= OP.OP_16) out.push(`OP_${op - OP.OP_1 + 1}`);
    else out.push(NAMES.get(op) ?? `0x${op.toString(16).padStart(2, "0")}`);
  }
  return out.join(" ");
}
