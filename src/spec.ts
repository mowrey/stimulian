import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./canonical.ts";

export const SPEC_SCHEMA = "stimuli.milestone/v1";

export type Criterion =
  | { id: string; type: "file_exists"; path: string }
  | { id: string; type: "file_contains"; path: string; pattern: string }
  | { id: string; type: "forbid_pattern"; pattern: string; paths?: string[] }
  | { id: string; type: "command"; run: string; timeoutSec?: number }
  | { id: string; type: "github_check"; name: string };

export interface MilestoneSpec {
  schema: typeof SPEC_SCHEMA;
  id: string;
  title: string;
  description?: string;
  repo: string; // owner/name of the client's repository
  client: { name: string; kaspaPubKey?: string };
  contractor: { github: string; kaspaAddress?: string };
  payout: { amountSompi: string; network: "kaspa-mainnet" | "kaspa-testnet-10" | "kaspa-testnet-11" };
  criteria: Criterion[];
}

const TYPES = new Set(["file_exists", "file_contains", "forbid_pattern", "command", "github_check"]);

export function validateSpec(raw: unknown): MilestoneSpec {
  const errs: string[] = [];
  const s = raw as Record<string, any>;
  if (!s || typeof s !== "object") throw new Error("spec must be a JSON object");
  if (s.schema !== SPEC_SCHEMA) errs.push(`schema must be "${SPEC_SCHEMA}"`);
  for (const k of ["id", "title", "repo"]) if (typeof s[k] !== "string" || !s[k]) errs.push(`${k} is required`);
  if (typeof s.repo === "string" && !/^[\w.-]+\/[\w.-]+$/.test(s.repo)) errs.push("repo must be owner/name");
  if (!s.client?.name) errs.push("client.name is required");
  if (!s.contractor?.github) errs.push("contractor.github is required");
  if (!/^\d+$/.test(String(s.payout?.amountSompi ?? ""))) errs.push("payout.amountSompi must be an integer string");
  if (!["kaspa-mainnet", "kaspa-testnet-10", "kaspa-testnet-11"].includes(s.payout?.network)) errs.push("payout.network is invalid");
  if (!Array.isArray(s.criteria) || s.criteria.length === 0) errs.push("criteria must be a non-empty array");
  const ids = new Set<string>();
  for (const [i, c] of (Array.isArray(s.criteria) ? s.criteria : []).entries()) {
    const at = `criteria[${i}]`;
    if (!c?.id) errs.push(`${at}.id is required`);
    else if (ids.has(c.id)) errs.push(`${at}.id "${c.id}" is duplicated`);
    else ids.add(c.id);
    if (!TYPES.has(c?.type)) { errs.push(`${at}.type "${c?.type}" is unknown`); continue; }
    if ((c.type === "file_exists" || c.type === "file_contains") && !c.path) errs.push(`${at}.path is required`);
    if (c.type === "file_contains" || c.type === "forbid_pattern") {
      if (!c.pattern) errs.push(`${at}.pattern is required`);
      else try { new RegExp(c.pattern); } catch { errs.push(`${at}.pattern is not a valid regex`); }
    }
    if (c.type === "command" && !c.run) errs.push(`${at}.run is required`);
    if (c.type === "github_check" && !c.name) errs.push(`${at}.name is required`);
    if (typeof c.path === "string" && (c.path.startsWith("/") || c.path.split(/[\\/]/).includes(".."))) {
      errs.push(`${at}.path must stay inside the repository`);
    }
  }
  if (errs.length) throw new Error("invalid milestone spec:\n  - " + errs.join("\n  - "));
  return s as MilestoneSpec;
}

export function loadSpec(path: string): MilestoneSpec {
  return validateSpec(JSON.parse(readFileSync(path, "utf8")));
}

// The hash both parties agree on when the milestone is funded. A proof is only
// valid for the exact spec it names.
export function specHash(spec: MilestoneSpec): string {
  return createHash("sha256").update(canonicalJson(spec)).digest("hex");
}
