#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkAll } from "./criteria.ts";
import { buildPayload, generateVerifierKey, signProof, verifyProof, type MilestoneProof } from "./proof.ts";
import { buildEscrow, parseLockTime } from "./kaspa/escrow.ts";
import { loadSpec, specHash } from "./spec.ts";

const USAGE = `stimulian — Stimuli Network milestone verifier

  keygen        --out <key.pem>
  hash-spec     --spec <milestone.json>
  check         --spec <milestone.json> [--repo-dir .] [--commit <sha>] [--allow-exec]
  prove         --spec <milestone.json> --commit <sha> --key <key.pem> [--repo-dir .] [--allow-exec] [--out proof.json]
  verify-proof  --proof <proof.json> [--spec <milestone.json>] [--trusted-key <base64>]...
  escrow        --spec <milestone.json> --client-key <hex> --contractor-key <hex> --verifier-key <hex>
                --refund-after <DAA score | ISO date>     (keys: 32-byte x-only Schnorr, hex)

GITHUB_TOKEN is used for github_check criteria when set.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    spec: { type: "string" }, "repo-dir": { type: "string", default: "." }, commit: { type: "string" },
    key: { type: "string" }, out: { type: "string" }, proof: { type: "string" },
    "trusted-key": { type: "string", multiple: true }, "client-key": { type: "string" },
    "contractor-key": { type: "string" }, "verifier-key": { type: "string" }, "refund-after": { type: "string" }, "allow-exec": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

function need(name: string, v: string | undefined): string {
  if (!v) { console.error(`--${name} is required\n\n${USAGE}`); process.exit(2); }
  return v;
}

async function main(): Promise<number> {
  const cmd = positionals[0];
  if (!cmd || values.help) { console.log(USAGE); return cmd ? 0 : 2; }

  if (cmd === "keygen") {
    const out = need("out", values.out);
    const k = generateVerifierKey();
    writeFileSync(out, k.privatePem, { mode: 0o600 });
    console.log(k.publicKey);
    return 0;
  }

  if (cmd === "hash-spec") { console.log(specHash(loadSpec(need("spec", values.spec)))); return 0; }

  if (cmd === "check" || cmd === "prove") {
    const spec = loadSpec(need("spec", values.spec));
    const commit = cmd === "prove" ? need("commit", values.commit) : values.commit;
    const results = await checkAll(spec.criteria, {
      repoDir: values["repo-dir"]!, commit, repo: spec.repo, allowExec: values["allow-exec"]!,
      github: { token: process.env.GITHUB_TOKEN },
    });
    for (const r of results) console.error(`${r.passed ? "PASS" : "FAIL"}  ${r.id}  ${r.detail}`);
    const passed = results.every((r) => r.passed);
    if (cmd === "prove") {
      const pem = readFileSync(need("key", values.key), "utf8");
      const publicKey = (createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }) as Buffer).toString("base64");
      const proof = signProof(buildPayload(spec, commit!, results, publicKey), pem);
      const json = JSON.stringify(proof, null, 2) + "\n";
      if (values.out) writeFileSync(values.out, json); else process.stdout.write(json);
    }
    console.error(passed ? "milestone PASSED" : "milestone FAILED");
    return passed ? 0 : 1;
  }

  if (cmd === "verify-proof") {
    const proof = JSON.parse(readFileSync(need("proof", values.proof), "utf8")) as MilestoneProof;
    const spec = values.spec ? loadSpec(values.spec) : undefined;
    const res = verifyProof(proof, { spec, trustedKeys: values["trusted-key"] });
    console.log(res.valid ? `VALID  milestone ${proof.payload.milestoneId} at ${proof.payload.commit}` : "INVALID\n  - " + res.reasons.join("\n  - "));
    return res.valid ? 0 : 1;
  }

  if (cmd === "escrow") {
    const spec = loadSpec(need("spec", values.spec));
    const escrow = buildEscrow({
      specSha256: specHash(spec),
      clientPubKey: need("client-key", values["client-key"]),
      contractorPubKey: need("contractor-key", values["contractor-key"]),
      verifierPubKey: need("verifier-key", values["verifier-key"]),
      refundLockTime: parseLockTime(need("refund-after", values["refund-after"])),
      network: spec.payout.network,
    });
    console.log(JSON.stringify({ milestoneId: spec.id, amountSompi: spec.payout.amountSompi, ...escrow }, null, 2));
    if (spec.payout.network === "kaspa-mainnet") console.error("warning: mainnet escrow. Stimuli Network tooling is testnet-only until legal review.");
    return 0;
  }

  console.error(`unknown command: ${cmd}\n\n${USAGE}`);
  return 2;
}

main().then((code) => process.exit(code), (e) => { console.error((e as Error).message); process.exit(2); });
