// Sanctions screening. Not legal advice.
//
// OFAC expects virtual-currency businesses, including non-custodial wallet and
// technology providers, to screen counterparties and wallet addresses against
// the SDN List and to block activity from comprehensively sanctioned
// jurisdictions, starting as early as beta testing:
// https://ofac.treasury.gov/media/913571/download
//
// This module screens addresses against:
//   1. the bundled list data/ofac-sdn-digital-currency-addresses.json, built
//      from OFAC's free official SDN list by scripts/update-ofac-sdn.ts
//      (every "Digital Currency Address - *" identifier, all chains); and
//   2. any extra denylist the operator supplies.
// Refresh procedure and limits: docs/sanctions-screening.md. Person and
// geography screening happen at sign-up in the Stimuli Network app (self-
// attestation); IP geoblocking is a mainnet prerequisite not built yet.
import { readFileSync } from "node:fs";
import type { SdnAddressList } from "./sdn.ts";

export interface ScreeningResult {
  screened: number;
  hits: string[];
  listSize: number;
}

export const BUNDLED_SDN_LIST = new URL("../../data/ofac-sdn-digital-currency-addresses.json", import.meta.url);

/** Refuse to co-sign with a bundled list older than this (fail closed). */
export const MAX_LIST_AGE_DAYS = 30;
/** Warn when the bundled list is older than this. */
export const WARN_LIST_AGE_DAYS = 7;

// Lowercased for matching. Base58 addresses are case-sensitive, so this can
// only add false positives (a stricter screen), never miss a listed address.
export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

// One address per line ("#" starts a comment), a JSON array of strings, or the
// JSON list written by scripts/update-ofac-sdn.ts.
export function parseDenylist(text: string): Set<string> {
  const t = text.trim();
  if (!t) return new Set();
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as unknown;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) throw new Error("denylist JSON must be an array of strings");
    return new Set((arr as string[]).map(normalizeAddress).filter(Boolean));
  }
  if (t.startsWith("{")) return new Set(parseSdnList(t).addresses.map((a) => normalizeAddress(a.address)).filter(Boolean));
  return new Set(
    t.split(/\r?\n/).map((l) => l.replace(/#.*/, "")).map(normalizeAddress).filter(Boolean),
  );
}

export function parseSdnList(text: string): SdnAddressList {
  const o = JSON.parse(text) as SdnAddressList;
  if (o?.schema !== "stimuli.ofac-sdn-addresses/v1" || !Array.isArray(o.addresses) || !/^\d{4}-\d{2}-\d{2}$/.test(o.publishDate ?? "")) {
    throw new Error("not a stimuli.ofac-sdn-addresses/v1 list");
  }
  if (o.addresses.some((a) => typeof a?.address !== "string")) throw new Error("SDN list has a malformed address entry");
  return o;
}

export function loadDenylist(path: string | URL): Set<string> {
  return parseDenylist(readFileSync(path, "utf8"));
}

export interface BundledList {
  denylist: Set<string>;
  publishDate: string;
  ageDays: number;
  byCurrency: Record<string, number>;
}

export function listAgeDays(publishDate: string, nowMs = Date.now()): number {
  return Math.floor((nowMs - Date.parse(`${publishDate}T00:00:00Z`)) / 86_400_000);
}

export function loadBundledSdnList(path: string | URL = BUNDLED_SDN_LIST, nowMs = Date.now()): BundledList {
  const list = parseSdnList(readFileSync(path, "utf8"));
  const denylist = new Set(list.addresses.map((a) => normalizeAddress(a.address)).filter(Boolean));
  if (denylist.size === 0) throw new Error("bundled SDN list is empty: run scripts/update-ofac-sdn.ts");
  return { denylist, publishDate: list.publishDate, ageDays: listAgeDays(list.publishDate, nowMs), byCurrency: list.byCurrency };
}

export function screenAddresses(addresses: Iterable<string>, denylist: ReadonlySet<string>): ScreeningResult {
  const seen = new Set<string>();
  for (const a of addresses) if (a) seen.add(normalizeAddress(a));
  return { screened: seen.size, hits: [...seen].filter((a) => denylist.has(a)), listSize: denylist.size };
}
