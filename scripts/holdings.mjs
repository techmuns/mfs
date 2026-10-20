// holdings.mjs — monthly job: build public/data/holdings.json from AMC monthly portfolio
// disclosures (SEBI-mandated). Run ~8th of the month, when disclosures post.
//
// Status: the xlsx reader + standard-layout parser + sector/concentration summary + fund matcher
// are validated against real SEBI files. The remaining work is per-AMC CURRENT-file retrieval:
// each AMC serves its latest file from a JS-rendered page (some PDF-only, needing OCR/Bedrock),
// so a fetcher must be wired per AMC. AMC_FETCHERS below is that extension point. Funds whose AMC
// is not yet wired are honestly reported as holdings.available=false (the default in funds.json).

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchText } from './lib/http.mjs';
import { readXlsx } from './lib/xlsx.mjs';
import { parsePortfolioSheet, summarizeHoldings, matchFund, buildAmcRegistry, HOLDINGS_SOURCE } from './lib/holdings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'public', 'data');
const AMFI_AUM_URL = 'https://www.amfiindia.com/aum-data/average-aum';

// Per-AMC resolver for the LATEST monthly portfolio file: name -> async () => { buffer, month }.
// Empty until wired; see module header. (When a Bedrock key is available, a generic resolver can
// render/OCR odd layouts here.)
const AMC_FETCHERS = {};

function roundReplacer(_k, v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 1e6) / 1e6 : v; }

async function main() {
  const funds = JSON.parse(readFileSync(join(DATA_DIR, 'funds.json'), 'utf8'));

  let registry = {};
  try { registry = buildAmcRegistry(await fetchText(AMFI_AUM_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })); }
  catch (e) { console.error('AMFI registry fetch failed:', e.message); }

  const out = {};
  const parsedAmcs = [], failedAmcs = [];
  for (const [amc, fetcher] of Object.entries(AMC_FETCHERS)) {
    try {
      const { buffer, month } = await fetcher();
      const { sheets } = readXlsx(buffer);
      let matched = 0;
      for (const sheet of sheets) {
        for (const sc of parsePortfolioSheet(sheet.rows)) {
          const f = matchFund(sc.scheme, funds);
          if (f) { out[f.schemeCode] = summarizeHoldings(sc.holdings, month); matched++; }
        }
      }
      parsedAmcs.push({ amc, matched });
    } catch (e) { failedAmcs.push({ amc, reason: String(e.message || e) }); }
  }

  const holdings = {
    generated_at: new Date().toISOString(),
    source: HOLDINGS_SOURCE,
    note: 'Best-effort. The parser + sector/concentration summary are validated against real SEBI-format files; per-AMC current-file retrieval (JS-rendered pages, some PDF-only) is being wired AMC by AMC. Funds without a parsed AMC show holdings.available=false.',
    registry,
    parsedAmcs,
    failedAmcs,
    coverage: { amcsWired: Object.keys(AMC_FETCHERS).length, amcsInRegistry: Object.keys(registry).length, fundsParsed: Object.keys(out).length },
    funds: out,
  };
  writeFileSync(join(DATA_DIR, 'holdings.json'), JSON.stringify(holdings, roundReplacer) + '\n');
  console.log(`holdings.json: ${Object.keys(out).length} funds parsed, ${Object.keys(registry).length} AMCs in registry, ${parsedAmcs.length} AMCs wired`);
}

main().catch((e) => { console.error('HOLDINGS BUILD FAILED:', e); process.exit(1); });
