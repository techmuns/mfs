# MF Screener — Indian Equity Mutual Fund Screener

A free, **research-only** web dashboard for Indian equity mutual funds. Pick a category
(Flexi Cap, Small Cap, ELSS, …) and compare funds on real returns, risk, and how each one
stacks up against its category peers — charts and tables only, plain English, no jargon.

> **Not an investment or transaction platform.** Nothing here is investment advice.
> Every number is computed from real NAV history with a documented formula, and carries its
> source and as-of date. Where history is insufficient, the screener shows **N/A** — never a
> fabricated or placeholder figure.

This repository is **Phase 1**: the data engine + a basic live page. Per-fund detail pages,
compare-up-to-5, benchmarks/holdings/fees and a composite score come in later phases.

---

## Architecture — static site + nightly data job (no backend server)

```
public/            → the static site, served as-is by Cloudflare Pages (no build step)
  index.html       → the page
  js/app.js        → vanilla ES module; reads the JSON below and renders the table
  data/*.json      → pre-computed data the browser loads (kept small)
scripts/           → Node 22 ESM (built-in fetch, zero npm dependencies)
  build.mjs        → the pipeline: fetch sources → compute every metric → write public/data/*.json
  verify.mjs       → sanity-checks a few well-known funds against an independent recomputation
  lib/*.mjs        → amfi (parse), mfapi (fetch), metrics (formulas), categories (aggregates), http, dates
  config/risk-free-rate.json → the RBI risk-free rate used in Sharpe/Sortino, with provenance
.github/workflows/refresh.yml → daily GitHub Action that rebuilds the data and commits it back
```

The whole design is **"compute nightly in CI → commit JSON → the static page just reads it."**
The browser never crunches NAV history; it only loads three small JSON files.

### Output files

| File | Contents |
| --- | --- |
| `public/data/funds.json` | One object per fund: returns, rolling, risk, vs-category, history, **benchmark excess, costs (TER), AUM, manager, exit load, riskometer, holdings summary**. |
| `public/data/categories.json` | Per peer group: mean + median + sample size per metric (incl. benchmark excess, median TER). |
| `public/data/benchmarks.json` | Per index: the Total Return Index (TRI) series (monthly), for detail/compare charts. |
| `public/data/holdings.json` | Per fund: full holdings + sector allocation (built by the monthly workflow; bulky, kept out of funds.json). |
| `public/data/status.json` | Run metadata: generated-at, sources + as-of, risk-free rate, fund counts, **field coverage**. |

---

## Data sources

1. **[MFAPI.in](https://www.mfapi.in/)** — free, no key, CORS-enabled. NAV history + scheme
   metadata (`GET https://api.mfapi.in/mf/{schemeCode}`). It is one person's free service, so
   the pipeline retries, times out and skips-with-log on failures, and never treats it as
   guaranteed.
2. **[AMFI NAVAll](https://portal.amfiindia.com/spages/NAVAll.txt)** — the official classified
   scheme universe (category + AMC). Fetched **server-side only** (it is not CORS-enabled).
   AMFI data is for personal / non-commercial use — fine for a research tool; the source is
   credited visibly on the page.
3. **RBI 91-day Treasury Bill cut-off yield** — the risk-free rate for Sharpe/Sortino, stored
   with its source and as-of date in `scripts/config/risk-free-rate.json`. Update it
   periodically from the latest RBI weekly T-Bill auction press release.
4. **[NSE Indices](https://www.niftyindices.com/)** (Phase 3A) — Total Return Index (TRI)
   history for benchmark comparison. Server-side only; each fund is compared against its filed
   benchmark where that is a Nifty index, else a peer-group Nifty proxy (stamped
   `benchmark.basis="category"`), never a silent substitution. BSE/foreign/unmappable → N/A.
5. **[tigzig](https://api.tigzig.com/)** (Phase 3A) — re-serves official AMFI/SEBI disclosures:
   TER, AUM, fund managers, exit load, riskometer, filed benchmark. One bulk gzipped CSV joined
   on scheme code. NAV returns are already net of fees, so TER is **not** deducted again.
6. **AMC monthly portfolio disclosures** (Phase 3A, SEBI-mandated) — holdings + sectors, built by
   the monthly workflow. A zero-dependency `.xlsx` reader + standard-layout parser are in
   `scripts/lib/{xlsx,holdings}.mjs`; per-AMC current-file retrieval is wired AMC by AMC.

## Phase-1 universe

Open-ended **equity** schemes, **Direct** plan, **Growth** option only (the client default;
Regular / IDCW and debt / hybrid / index come later). All equity sub-categories are included
and normalised to canonical SEBI categories (Flexi Cap, Large Cap, Large & Mid Cap, Mid Cap,
Small Cap, Multi Cap, ELSS, Focused, Value/Contra, Dividend Yield, Sectoral/Thematic).

## Metrics (all formulas documented in `scripts/lib/metrics.mjs`)

- **Trailing returns** at 1M/3M/6M/1Y/3Y/5Y/10Y/since-inception. ≤ 12 months → absolute;
  > 12 months → CAGR with a 365.25-day year. Insufficient history → `null` (N/A), never 0.
- **Rolling returns** (3Y & 5Y): monthly window starts across the whole history; each window's
  CAGR; reported as `{ avg, median, min, max, pctPositive, n }`. `n` is the window count and
  doubles as the confidence signal (read `n < 12` as low-confidence).
- **Risk** over a 3-year lookback (full history if younger, flagged via `lookbackYears`):
  annualised volatility (`stdev(daily returns) × √252`), Sharpe, max drawdown, Sortino.
- **Category averages**: mean + median per metric over the Direct-Growth funds only (each
  portfolio counted once), plus each fund's **vs-category** ratio and percentage-point gap.

---

## Run it locally

Requires **Node 22+**. No `npm install` — there are no dependencies.

```bash
node scripts/build.mjs     # fetches live data and writes public/data/*.json  (~20–60s)
node scripts/verify.mjs    # prints a sanity check for 3 well-known funds

# serve the static site to view it
cd public && python3 -m http.server 8099   # then open http://localhost:8099
```

## Automated refresh

`.github/workflows/refresh.yml` runs **daily** (`01:17 UTC ≈ 06:47 IST`) and on-demand. It rebuilds
everything — NAV metrics (MFAPI), fees/AUM/manager (tigzig), and benchmark excess (NSE TRI) — and
commits the changed `public/data/*.json` with a resilient push. Benchmark/disclosure fetches are
**fail-soft**: if a source is down, the prior committed value is carried forward and marked
`stale:true`, so the run never wipes good data.

`.github/workflows/holdings.yml` runs **monthly** (8th, when SEBI portfolio disclosures post) to
rebuild `holdings.json` and re-run the main build so funds pick up holdings summaries. It reads the
optional Bedrock secrets (`BEDROCK_API_KEY`, `AWS_REGION`, `BEDROCK_MODEL_IDS`) when present, to
parse odd/PDF-only AMC layouts; without them it falls back to deterministic parsing.

Each commit triggers a Cloudflare Pages deploy — so the live site refreshes itself with no human in
the loop.

---

## One-time setup: connect to Cloudflare Pages (auto-deploy forever)

Do this **once**. After it's wired up, every push to the production branch — including the
nightly data commit from the Action above — deploys automatically. You never deploy by hand.

1. Push this repo to GitHub (done — see the repo's default branch).
2. In the **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git**, pick
   this repository and authorise Cloudflare's GitHub app for it.
3. On the build-configuration screen, set:
   - **Framework preset:** `None`
   - **Build command:** *(leave empty)*
   - **Build output directory:** `public`
   - **Production branch:** your default branch (e.g. `main`)
4. Click **Save and Deploy**. Cloudflare builds the first deployment and gives you a
   `*.pages.dev` URL.

That's it. Cloudflare now watches the repo: each push publishes production, and each pull
request gets its own preview URL. The nightly GitHub Action commits fresh data → Cloudflare
redeploys automatically. (Optional: add a custom domain under the Pages project's **Custom
domains** tab.)

> No build step, no server, no secrets needed for deployment — the site is just the static
> files in `public/`.
