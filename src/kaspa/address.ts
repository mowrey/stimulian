// Kaspa address encoding (cashaddr-style bech32), ported from rusty-kaspa
// crypto/addresses/src/bech32.rs.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type Network = "kaspa-mainnet" | "kaspa-testnet-10" | "kaspa-testnet-11";
export const PREFIX: Record<Network, string> = {
  "kaspa-mainnet": "kaspa",
  "kaspa-testnet-10": "kaspatest",
  "kaspa-testnet-11": "kaspatest",
};
export const VERSION = { PubKey: 0, PubKeyECDSA: 1, ScriptHash: 8 } as const;
const PAYLOAD_LEN: Record<number, number> = { 0: 32, 1: 33, 8: 32 };

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    if (c0 & 0x01n) c ^= 0x98f2bc8e61n;
    if (c0 & 0x02n) c ^= 0x79b76d99e2n;
    if (c0 & 0x04n) c ^= 0xf33e5fb3c4n;
    if (c0 & 0x08n) c ^= 0xae2eabe2a8n;
    if (c0 & 0x10n) c ^= 0x1e4f43e470n;
  }
  return c ^ 1n;
}

function checksum(payload5: number[], prefix: string): bigint {
  return polymod([...[...prefix].map((ch) => ch.charCodeAt(0) & 0x1f), 0, ...payload5, 0, 0, 0, 0, 0, 0, 0, 0]);
}

function conv8to5(data: number[]): number[] {
  const out: number[] = [];
  let buff = 0, bits = 0;
  for (const c of data) {
    buff = (buff << 8) | c; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((buff >> bits) & 31); buff &= (1 << bits) - 1; }
  }
  if (bits > 0) out.push((buff << (5 - bits)) & 31);
  return out;
}

function conv5to8(data: number[]): number[] {
  const out: number[] = [];
  let buff = 0, bits = 0;
  for (const c of data) {
    buff = (buff << 5) | c; bits += 5;
    while (bits >= 8) { bits -= 8; out.push((buff >> bits) & 0xff); buff &= (1 << bits) - 1; }
  }
  return out;
}

export function encodeAddress(prefix: string, version: number, payload: Uint8Array): string {
  if (PAYLOAD_LEN[version] !== payload.length) throw new Error(`version ${version} needs a ${PAYLOAD_LEN[version]}-byte payload`);
  const p5 = conv8to5([version, ...payload]);
  const cs = checksum(p5, prefix);
  const csBytes: number[] = [];
  for (let i = 4; i >= 0; i--) csBytes.push(Number((cs >> BigInt(i * 8)) & 0xffn));
  return prefix + ":" + [...p5, ...conv8to5(csBytes)].map((d) => CHARSET[d]).join("");
}

export function decodeAddress(address: string): { prefix: string; version: number; payload: Uint8Array } {
  const [prefix, body] = address.toLowerCase().split(":");
  if (!prefix || !body || body.length < 9) throw new Error("malformed Kaspa address");
  const v5 = [...body].map((ch) => {
    const i = CHARSET.indexOf(ch);
    if (i < 0) throw new Error(`invalid character "${ch}" in address`);
    return i;
  });
  const payload5 = v5.slice(0, -8);
  const csBytes = conv5to8(v5.slice(-8));
  const cs = csBytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  if (checksum(payload5, prefix) !== cs) throw new Error("bad address checksum");
  const [version, ...payload] = conv5to8(payload5);
  if (PAYLOAD_LEN[version] !== payload.length) throw new Error("unexpected address payload length");
  return { prefix, version, payload: Uint8Array.from(payload) };
}
