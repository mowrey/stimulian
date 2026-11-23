// Sanctions screening hook (placeholder). Not legal advice.
//
// OFAC expects virtual-currency businesses, including non-custodial wallet and
// technology providers, to screen counterparties and wallet addresses against
// the SDN List and to block activity from comprehensively sanctioned
// jurisdictions, starting as early as beta testing:
// https://ofac.treasury.gov/media/913571/download
//
// This module only does the mechanical part: normalize addresses and check
// them against a denylist the operator supplies. It ships with no list. Before
// any real-money use, the operator must populate it from OFAC's published data
// (digital currency address IDs on the SDN List) and/or a screening vendor,
// keep it current, and add person/geography screening at onboarding.
import { readFileSync } from "node:fs";

export interface ScreeningResult {
  screened: number;
  hits: string[];
  listSize: number;
}

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

// One address per line ("#" starts a comment), or a JSON array of strings.
export function parseDenylist(text: string): Set<string> {
  const t = text.trim();
  if (!t) return new Set();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) throw new Error("denylist JSON must be an array of strings");
    return new Set((arr as string[]).map(normalizeAddress).filter(Boolean));
  }
  return new Set(
    t.split(/\r?\n/).map((l) => l.replace(/#.*/, "")).map(normalizeAddress).filter(Boolean),
  );
}

export function loadDenylist(path: string): Set<string> {
  return parseDenylist(readFileSync(path, "utf8"));
}

export function screenAddresses(addresses: Iterable<string>, denylist: ReadonlySet<string>): ScreeningResult {
  const seen = new Set<string>();
  for (const a of addresses) if (a) seen.add(normalizeAddress(a));
  return { screened: seen.size, hits: [...seen].filter((a) => denylist.has(a)), listSize: denylist.size };
}
