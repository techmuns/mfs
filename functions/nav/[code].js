// functions/nav/[code].js — same-origin proxy for MFAPI NAV history (Cloudflare Pages Function).
//
// Why this exists: MFAPI (api.mfapi.in) stopped sending an `Access-Control-Allow-Origin` header on
// its GET responses (only its OPTIONS preflight carries one), so a direct browser fetch from the site
// is blocked by CORS and the fund-detail growth charts fail with "Could not load live NAV". Fetching
// it HERE — server to server, where CORS does not apply — and returning it from our own origin fixes
// the charts. The response is cached at the Cloudflare edge for an hour, which also hides MFAPI's slow
// cache-miss responses (20s+) from everyone after the first request.
//
// Deployed automatically by Cloudflare Pages: the `functions/` directory at the repo root is compiled
// to a Worker and routed at `/nav/:code`, while the static site is served from `public/`.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };

export async function onRequestGet({ params }) {
  const code = String(params.code || '').replace(/\D/g, '');
  if (!code) return new Response(JSON.stringify({ error: 'bad scheme code' }), { status: 400, headers: JSON_HEADERS });

  let upstream;
  try {
    upstream = await fetch(`https://api.mfapi.in/mf/${code}`, {
      headers: { 'User-Agent': 'mfs-screener (+https://github.com/techmuns/mfs)' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'upstream fetch failed' }), { status: 502, headers: JSON_HEADERS });
  }
  if (!upstream.ok) return new Response(JSON.stringify({ error: `upstream ${upstream.status}` }), { status: 502, headers: JSON_HEADERS });

  const body = await upstream.text();
  return new Response(body, { status: 200, headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=3600' } });
}
