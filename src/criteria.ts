import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Criterion } from "./spec.ts";

export interface CriterionResult {
  id: string;
  type: Criterion["type"];
  passed: boolean;
  detail: string;
}

export interface CheckContext {
  repoDir: string;
  commit?: string;
  repo?: string;
  allowExec: boolean;
  github?: { token?: string; apiUrl?: string; fetchImpl?: typeof fetch };
}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "target"]);
const MAX_FILE_BYTES = 2_000_000;

function inside(root: string, p: string): string {
  const full = resolve(root, p);
  if (relative(root, full).startsWith("..")) throw new Error(`path escapes repository: ${p}`);
  return full;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile() && st.size <= MAX_FILE_BYTES) yield p;
  }
}

async function githubCheck(name: string, ctx: CheckContext): Promise<{ passed: boolean; detail: string }> {
  if (!ctx.repo || !ctx.commit) return { passed: false, detail: "repo and commit are required for github_check" };
  const f = ctx.github?.fetchImpl ?? fetch;
  const api = ctx.github?.apiUrl ?? "https://api.github.com";
  const url = `${api}/repos/${ctx.repo}/commits/${ctx.commit}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`;
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "stimulian-verifier" };
  if (ctx.github?.token) headers.authorization = `Bearer ${ctx.github.token}`;
  const res = await f(url, { headers });
  if (!res.ok) return { passed: false, detail: `GitHub API answered ${res.status}` };
  const body = (await res.json()) as { check_runs?: { name: string; status: string; conclusion: string | null; completed_at?: string }[] };
  const runs = (body.check_runs ?? []).filter((r) => r.name === name);
  if (!runs.length) return { passed: false, detail: `no check run named "${name}" on ${ctx.commit.slice(0, 12)}` };
  runs.sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")));
  const latest = runs[0];
  return latest.status === "completed" && latest.conclusion === "success"
    ? { passed: true, detail: `check "${name}" succeeded` }
    : { passed: false, detail: `check "${name}" is ${latest.status}/${latest.conclusion ?? "pending"}` };
}

export async function checkCriterion(c: Criterion, ctx: CheckContext): Promise<CriterionResult> {
  const out = (passed: boolean, detail: string): CriterionResult => ({ id: c.id, type: c.type, passed, detail });
  try {
    switch (c.type) {
      case "file_exists": {
        return existsSync(inside(ctx.repoDir, c.path)) ? out(true, `${c.path} exists`) : out(false, `${c.path} is missing`);
      }
      case "file_contains": {
        const p = inside(ctx.repoDir, c.path);
        if (!existsSync(p)) return out(false, `${c.path} is missing`);
        return new RegExp(c.pattern, "m").test(readFileSync(p, "utf8"))
          ? out(true, `${c.path} matches /${c.pattern}/`)
          : out(false, `${c.path} does not match /${c.pattern}/`);
      }
      case "forbid_pattern": {
        const re = new RegExp(c.pattern, "m");
        const roots = (c.paths?.length ? c.paths : ["."]).map((p) => inside(ctx.repoDir, p)).filter(existsSync);
        const hits: string[] = [];
        for (const root of roots) {
          const files = statSync(root).isFile() ? [root] : [...walk(root)];
          for (const f of files) if (re.test(readFileSync(f, "utf8"))) hits.push(relative(ctx.repoDir, f));
        }
        return hits.length ? out(false, `forbidden pattern found in ${hits.slice(0, 5).join(", ")}`) : out(true, "no forbidden pattern found");
      }
      case "command": {
        if (!ctx.allowExec) return out(false, "command criteria run contractor code; refused without --allow-exec");
        const r = spawnSync(c.run, { cwd: ctx.repoDir, shell: true, timeout: (c.timeoutSec ?? 600) * 1000, encoding: "utf8" });
        if (r.error) return out(false, `failed to run: ${r.error.message}`);
        return r.status === 0 ? out(true, `"${c.run}" exited 0`) : out(false, `"${c.run}" exited ${r.status ?? r.signal}`);
      }
      case "github_check": {
        const r = await githubCheck(c.name, ctx);
        return out(r.passed, r.detail);
      }
    }
  } catch (e) {
    return out(false, `error: ${(e as Error).message}`);
  }
}

export async function checkAll(criteria: Criterion[], ctx: CheckContext): Promise<CriterionResult[]> {
  const results: CriterionResult[] = [];
  for (const c of criteria) results.push(await checkCriterion(c, ctx));
  return results;
}
