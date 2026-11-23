#!/usr/bin/env node
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { checkAll } from "./criteria.ts";
import { buildPayload, generateVerifierKey, signProof, verifyProof, type MilestoneProof } from "./proof.ts";
import { buildEscrow, checkRefundLockTime, parseLockTime } from "./kaspa/escrow.ts";
import { verifierCosignDecision, type CosignRequest } from "./kaspa/policy.ts";
import { loadBundledSdnList, loadDenylist, MAX_LIST_AGE_DAYS, WARN_LIST_AGE_DAYS } from "./compliance/screening.ts";
import { cascadeReport, simulateCascade } from "./model/cascade.ts";
import { estimateGainPerAlpha, simulateGateSweep, simulateRefinement } from "./model/convergence.ts";
import { loadSpec, specHash } from "./spec.ts";

const USAGE = `stimulian — Stimuli Network milestone verifier

  keygen        --out <key.pem>
  hash-spec     --spec <milestone.json>
  check         --spec <milestone.json> [--repo-dir .] [--commit <sha>] [--allow-exec]
  prove         --spec <milestone.json> --commit <sha> --key <key.pem> [--repo-dir .] [--allow-exec] [--out proof.json]
  verify-proof  --proof <proof.json> [--spec <milestone.json>] [--trusted-key <base64>]...
  escrow        --spec <milestone.json> --client-key <hex> --contractor-key <hex> --verifier-key <hex>
                --refund-after <DAA score | ISO date> [--current-daa <score>]
                (keys: 32-byte x-only Schnorr, hex; testnet only)
  cosign-check  --request <cosign.json> [--denylist <file>] [--operator <address>]...
                (verifier policy check before co-signing a release; exit 0 = allowed.
                 Always screens against the bundled OFAC SDN address list, data/; --denylist adds more.
                 Refuses when that list is over ${MAX_LIST_AGE_DAYS} days old: run scripts/update-ofac-sdn.ts)
  sdn-status    (date and size of the bundled OFAC SDN address list)
  cascade       --n <fan-out> --delta <fidelity> [--hops 12] [--runs <monte carlo runs>] [--seed 1]
  gate          --nodes <N> [--alpha 2] [--replications 3000] [--seed 1]      (theta sweep of one convergence step)
  refine        --alpha <rate> [--theta 0.6] [--rounds 40] [--runs 200] [--seed 1]   (recursive refinement)

GITHUB_TOKEN is used for github_check criteria when set.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    spec: { type: "string" }, "repo-dir": { type: "string", default: "." }, commit: { type: "string" },
    key: { type: "string" }, out: { type: "string" }, proof: { type: "string" },
    "trusted-key": { type: "string", multiple: true }, "client-key": { type: "string" },
    "contractor-key": { type: "string" }, "verifier-key": { type: "string" }, "refund-after": { type: "string" }, "current-daa": { type: "string" },
    request: { type: "string" }, denylist: { type: "string" }, operator: { type: "string", multiple: true }, "allow-exec": { type: "boolean", default: false },
    n: { type: "string" }, delta: { type: "string" }, hops: { type: "string", default: "12" }, runs: { type: "string" }, seed: { type: "string", default: "1" },
    nodes: { type: "string" }, alpha: { type: "string" }, theta: { type: "string", default: "0.6" }, rounds: { type: "string", default: "40" }, replications: { type: "string", default: "3000" },
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
    const refundLockTime = parseLockTime(need("refund-after", values["refund-after"]));
    const currentDaa = values["current-daa"];
    if (currentDaa !== undefined && !/^\d+$/.test(currentDaa)) throw new Error("--current-daa must be a non-negative integer");
    for (const w of checkRefundLockTime(refundLockTime, BigInt(Date.now()), currentDaa === undefined ? undefined : BigInt(currentDaa))) {
      console.error(`warning: ${w}`);
    }
    const escrow = buildEscrow({
      specSha256: specHash(spec),
      clientPubKey: need("client-key", values["client-key"]),
      contractorPubKey: need("contractor-key", values["contractor-key"]),
      verifierPubKey: need("verifier-key", values["verifier-key"]),
      refundLockTime,
      network: spec.payout.network,
    });
    console.log(JSON.stringify({ milestoneId: spec.id, amountSompi: spec.payout.amountSompi, ...escrow }, null, 2));
    return 0;
  }

  if (cmd === "cosign-check") {
    const raw = JSON.parse(readFileSync(need("request", values.request), "utf8")) as Omit<CosignRequest, "outputs"> & {
      outputs: { address: string; amountSompi: string | number }[];
    };
    if (!Array.isArray(raw.outputs)) throw new Error("request.outputs must be an array");
    const req: CosignRequest = {
      ...raw,
      outputs: raw.outputs.map((o) => {
        if (!/^\d+$/.test(String(o.amountSompi))) throw new Error("output amountSompi must be an integer");
        return { address: String(o.address), amountSompi: BigInt(o.amountSompi) };
      }),
    };
    const sdn = loadBundledSdnList();
    const denylist = new Set(sdn.denylist);
    if (values.denylist) for (const a of loadDenylist(values.denylist)) denylist.add(a);
    const decision = verifierCosignDecision(req, { operatorAddresses: values.operator ?? [], denylist });
    if (sdn.ageDays > MAX_LIST_AGE_DAYS) {
      decision.allow = false;
      decision.reasons.push(`the bundled OFAC SDN list (published ${sdn.publishDate}) is ${sdn.ageDays} days old; refresh it with scripts/update-ofac-sdn.ts before co-signing`);
    } else if (sdn.ageDays > WARN_LIST_AGE_DAYS) {
      console.error(`warning: the bundled OFAC SDN list is ${sdn.ageDays} days old (published ${sdn.publishDate}); refresh it soon`);
    }
    console.log(JSON.stringify(decision, null, 2));
    return decision.allow ? 0 : 1;
  }

  if (cmd === "sdn-status") {
    const sdn = loadBundledSdnList();
    console.log(JSON.stringify({ publishDate: sdn.publishDate, ageDays: sdn.ageDays, addresses: sdn.denylist.size, byCurrency: sdn.byCurrency, maxAgeDays: MAX_LIST_AGE_DAYS }, null, 2));
    return sdn.ageDays > MAX_LIST_AGE_DAYS ? 1 : 0;
  }

  if (cmd === "cascade") {
    const p = { n: Number(need("n", values.n)), delta: Number(need("delta", values.delta)) };
    const hops = Number(values.hops);
    const report: Record<string, unknown> = { ...cascadeReport(p, hops) };
    if (values.runs) report.monteCarlo = simulateCascade(p, { hops, runs: Number(values.runs), seed: Number(values.seed) });
    console.log(JSON.stringify(report, (_, v) => (v === Infinity ? "Infinity" : v), 2));
    return 0;
  }

  if (cmd === "gate") {
    const N = Number(need("nodes", values.nodes));
    const thetas = Array.from({ length: 20 }, (_, i) => Math.round((i * 0.95 / 19) * 1e4) / 1e4);
    const points = simulateGateSweep({ N, alpha: Number(values.alpha ?? "2"), thetas, replications: Number(values.replications), seed: Number(values.seed) });
    const best = points.reduce((a, b) => (b.mse < a.mse ? b : a));
    console.log(JSON.stringify({ N, optimum: best, points }, null, 2));
    return 0;
  }

  if (cmd === "refine") {
    const alpha = Number(need("alpha", values.alpha));
    const theta = Number(values.theta);
    const rounds = Number(values.rounds);
    const sim = simulateRefinement({ alpha, theta, rounds, runs: Number(values.runs ?? "200"), seed: Number(values.seed) });
    const gain = estimateGainPerAlpha({ theta, draws: 2000, seed: Number(values.seed) });
    console.log(JSON.stringify({ alpha, theta, rounds, gainPerAlpha: gain, predictedStableBelow: 2 / gain.mean, ...sim }, null, 2));
    return 0;
  }

  console.error(`unknown command: ${cmd}\n\n${USAGE}`);
  return 2;
}

main().then((code) => process.exit(code), (e) => { console.error((e as Error).message); process.exit(2); });
