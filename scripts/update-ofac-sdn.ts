#!/usr/bin/env node
// Refresh data/ofac-sdn-digital-currency-addresses.json from OFAC's free,
// official SDN list. Manual, no paid vendor, no scheduled infrastructure.
//
//   node scripts/update-ofac-sdn.ts                 # download SDN.XML from OFAC
//   node scripts/update-ofac-sdn.ts --file SDN.XML  # use a copy you downloaded
//
// Source: OFAC Sanctions List Service (https://sanctionslist.ofac.treas.gov/),
// SDN list in XML. Every identifier whose type starts with
// "Digital Currency Address - " is kept, for every chain (XBT, ETH, TRX, USDT,
// ... and Kaspa if OFAC ever lists one). See docs/sanctions-screening.md.
// Not legal advice.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { extractDigitalCurrencyAddresses } from "../src/compliance/sdn.ts";

export const SDN_XML_URL = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
const OUT = new URL("../data/ofac-sdn-digital-currency-addresses.json", import.meta.url);

const { values } = parseArgs({ options: { file: { type: "string" }, out: { type: "string" } } });

async function main(): Promise<void> {
  let xml: string;
  let source: string;
  if (values.file) {
    xml = readFileSync(values.file, "utf8");
    source = `${SDN_XML_URL} (local copy: ${values.file})`;
  } else {
    const res = await fetch(SDN_XML_URL, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`OFAC download failed: HTTP ${res.status}`);
    xml = await res.text();
    source = SDN_XML_URL;
  }
  const list = extractDigitalCurrencyAddresses(xml, {
    source,
    sourceSha256: createHash("sha256").update(xml).digest("hex"),
    generatedAt: new Date().toISOString(),
  });
  if (list.addressCount === 0) throw new Error("no digital currency addresses found: refusing to write an empty list (did the format change?)");
  const out = values.out ?? OUT;
  writeFileSync(out, JSON.stringify(list, null, 1) + "\n");
  console.log(`OFAC SDN published ${list.publishDate}: ${list.addressCount} addresses from ${list.sdnEntryCount} SDN entries`);
  console.log(Object.entries(list.byCurrency).map(([k, v]) => `${k}=${v}`).join(" "));
  console.log(`wrote ${String(out)}`);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
