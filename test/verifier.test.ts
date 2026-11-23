import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalJson } from "../src/canonical.ts";
import { checkAll, checkCriterion } from "../src/criteria.ts";
import { buildPayload, generateVerifierKey, signProof, verifyProof } from "../src/proof.ts";
import { specHash, validateSpec, type MilestoneSpec } from "../src/spec.ts";

const SHA = "a".repeat(40);

function spec(overrides: Partial<MilestoneSpec> = {}): MilestoneSpec {
  return validateSpec({
    schema: "stimuli.milestone/v1",
    id: "m1",
    title: "Milestone one",
    repo: "client/app",
    client: { name: "Client" },
    contractor: { github: "student" },
    payout: { amountSompi: "100000000", network: "kaspa-testnet-10" },
    criteria: [
      { id: "readme", type: "file_exists", path: "README.md" },
      { id: "route", type: "file_contains", path: "src/routes.ts", pattern: "/inventory" },
      { id: "no-keys", type: "forbid_pattern", pattern: "BEGIN [A-Z ]*PRIVATE KEY" },
    ],
    ...overrides,
  });
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "stimulian-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const good = { "README.md": "# app", "src/routes.ts": "app.get('/inventory', list)" };

test("canonical JSON is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("spec validation rejects bad specs", () => {
  assert.throws(() => validateSpec({ schema: "x" }), /invalid milestone spec/);
  assert.throws(() => spec({ criteria: [{ id: "x", type: "file_exists", path: "../etc/passwd" }] }), /inside the repository/);
  assert.throws(() => spec({ criteria: [{ id: "x", type: "file_exists", path: "a" }, { id: "x", type: "file_exists", path: "b" }] }), /duplicated/);
  assert.throws(() => spec({ payout: { amountSompi: "1.5", network: "kaspa-testnet-10" } }), /amountSompi/);
});

test("all criteria pass on a good delivery", async () => {
  const results = await checkAll(spec().criteria, { repoDir: repo(good), allowExec: false });
  assert.ok(results.every((r) => r.passed), JSON.stringify(results));
});

test("criteria fail on a bad delivery", async () => {
  const dir = repo({ "src/routes.ts": "nothing", "src/k.pem": "-----BEGIN RSA PRIVATE KEY-----" });
  const byId = Object.fromEntries((await checkAll(spec().criteria, { repoDir: dir, allowExec: false })).map((r) => [r.id, r.passed]));
  assert.deepEqual(byId, { readme: false, route: false, "no-keys": false });
});

test("command criteria are refused unless exec is allowed", async () => {
  const c = { id: "t", type: "command" as const, run: "exit 0" };
  assert.equal((await checkCriterion(c, { repoDir: repo(good), allowExec: false })).passed, false);
  assert.equal((await checkCriterion(c, { repoDir: repo(good), allowExec: true })).passed, true);
  assert.equal((await checkCriterion({ ...c, run: "exit 3" }, { repoDir: repo(good), allowExec: true })).passed, false);
});

test("github_check reads the check run conclusion", async () => {
  const fake = (conclusion: string) => (async () => new Response(JSON.stringify({ check_runs: [{ name: "milestone-tests", status: "completed", conclusion }] }))) as typeof fetch;
  const c = { id: "tests", type: "github_check" as const, name: "milestone-tests" };
  const ctx = (f: typeof fetch) => ({ repoDir: ".", repo: "client/app", commit: SHA, allowExec: false, github: { fetchImpl: f } });
  assert.equal((await checkCriterion(c, ctx(fake("success")))).passed, true);
  assert.equal((await checkCriterion(c, ctx(fake("failure")))).passed, false);
});

test("signed proof verifies, and tampering is caught", async () => {
  const s = spec();
  const key = generateVerifierKey();
  const results = await checkAll(s.criteria, { repoDir: repo(good), allowExec: false });
  const proof = signProof(buildPayload(s, SHA, results, key.publicKey), key.privatePem);

  assert.deepEqual(verifyProof(proof, { spec: s, trustedKeys: [key.publicKey] }), { valid: true, reasons: [] });
  assert.match(verifyProof(proof, { trustedKeys: [generateVerifierKey().publicKey] }).reasons.join(), /not trusted/);

  const forged = structuredClone(proof);
  forged.payload.payout.amountSompi = "999999999999";
  assert.equal(verifyProof(forged).valid, false);

  const otherSpec = spec({ title: "weakened" });
  assert.notEqual(specHash(otherSpec), specHash(s));
  assert.match(verifyProof(proof, { spec: otherSpec }).reasons.join(), /different milestone spec/);
});

test("a failed milestone yields a valid signature but an unusable proof", async () => {
  const s = spec();
  const key = generateVerifierKey();
  const results = await checkAll(s.criteria, { repoDir: repo({}), allowExec: false });
  const proof = signProof(buildPayload(s, SHA, results, key.publicKey), key.privatePem);
  assert.equal(proof.payload.passed, false);
  assert.match(verifyProof(proof).reasons.join(), /did not pass/);
});

test("example spec is valid", () => {
  validateSpec(JSON.parse(readFileSync(new URL("../examples/river-rescue-m1.json", import.meta.url), "utf8")));
});
