// Parse OFAC's SDN.XML into a sanctions address list. No dependencies: the
// SDN XML is flat and regular, so a small tag reader is enough. Not legal advice.

export interface SdnAddress {
  address: string;   // as published by OFAC (case preserved)
  currency: string;  // OFAC's code after "Digital Currency Address - ", e.g. XBT, ETH, TRX
  sdnUid: string;    // OFAC entry uid
  name: string;      // SDN entry name, for reviewing a hit
}

export interface SdnAddressList {
  schema: "stimuli.ofac-sdn-addresses/v1";
  source: string;
  sourceSha256: string;
  publishDate: string;     // OFAC Publish_Date, ISO yyyy-mm-dd
  generatedAt: string;
  sdnEntryCount: number;
  addressCount: number;
  byCurrency: Record<string, number>;
  addresses: SdnAddress[];
}

const PREFIX = "Digital Currency Address - ";

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? decodeXml(m[1]!.trim()) : undefined;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** OFAC writes Publish_Date as MM/DD/YYYY. */
export function isoPublishDate(raw: string | undefined): string {
  const m = raw?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`unexpected Publish_Date: ${raw ?? "(missing)"}`);
  return `${m[3]}-${m[1]}-${m[2]}`;
}

export function extractDigitalCurrencyAddresses(
  xml: string,
  meta: { source: string; sourceSha256: string; generatedAt: string },
): SdnAddressList {
  const publishDate = isoPublishDate(tag(xml.slice(0, 2000), "Publish_Date"));
  const addresses: SdnAddress[] = [];
  const seen = new Set<string>();
  let sdnEntryCount = 0;
  for (const entry of xml.matchAll(/<sdnEntry>([\s\S]*?)<\/sdnEntry>/g)) {
    sdnEntryCount++;
    const block = entry[1]!;
    if (!block.includes(PREFIX)) continue;
    const sdnUid = tag(block, "uid") ?? "";
    const name = [tag(block, "firstName"), tag(block, "lastName")].filter(Boolean).join(" ");
    for (const id of block.matchAll(/<id>([\s\S]*?)<\/id>/g)) {
      const type = tag(id[1]!, "idType") ?? "";
      if (!type.startsWith(PREFIX)) continue;
      const address = (tag(id[1]!, "idNumber") ?? "").trim();
      if (!address) continue;
      const currency = type.slice(PREFIX.length).trim();
      const key = `${currency}:${address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push({ address, currency, sdnUid, name });
    }
  }
  addresses.sort((a, b) => a.currency.localeCompare(b.currency) || a.address.localeCompare(b.address));
  const byCurrency: Record<string, number> = {};
  for (const a of addresses) byCurrency[a.currency] = (byCurrency[a.currency] ?? 0) + 1;
  return {
    schema: "stimuli.ofac-sdn-addresses/v1",
    source: meta.source,
    sourceSha256: meta.sourceSha256,
    publishDate,
    generatedAt: meta.generatedAt,
    sdnEntryCount,
    addressCount: addresses.length,
    byCurrency: Object.fromEntries(Object.entries(byCurrency).sort(([a], [b]) => a.localeCompare(b))),
    addresses,
  };
}
