// peergroup.mjs — split the giant "Sectoral/Thematic" bucket into real peer groups.
//
// Problem: ~250 of 574 funds are tagged "Sectoral/Thematic", so a single category average
// there mixes banking, pharma, tech, energy… — an unfair comparison. The fix is a PEER GROUP:
// for diversified categories peerGroup == category, but Sectoral/Thematic funds are routed to
// "Thematic: <Theme>" by matching keywords in the scheme name. All category averages and each
// fund's vs-category comparison are then computed against the peer group, not the raw category.
//
// Theme map: FIRST match wins (order matters — e.g. "power" routes to Energy before "infra"),
// matched case-insensitively against the lowercased scheme name. No match => "Thematic: Other".

export const THEME_MAP = [
  ['Banking & Financial', /bank|financ|bfsi/],
  ['Technology', /tech|digital|\bit\b|internet/],
  ['Pharma & Healthcare', /pharma|health|medic/],
  ['Energy & Power', /energ|power|oil|gas|petro/],
  ['Infrastructure', /infra|capital goods/],
  ['Consumption', /consum|fmcg/],
  ['Auto', /auto|mobilit|\bev\b/],
  ['Metals & Commodities', /metal|commodit|resource/],
  ['Manufacturing', /manufactur|make in india|make-in-india/],
  ['International', /internation|global|\bus\b|nasdaq|s&p|china|world|overseas|emerging|foreign/],
  ['Realty', /realty|real estate/],
  ['MNC', /mnc/],
  ['ESG', /esg/],
];

/**
 * Strip a leading AMC name from a scheme name so theme keywords in the AMC don't cause a
 * false match. AMFI scheme names start with the fund house, e.g. "Bank of India Manufacturing
 * & Infrastructure Fund" — without this, "bank" would mislabel it Banking & Financial.
 */
function stripAmc(name, amc) {
  const n = (name || '').trim();
  if (!amc) return n;
  const core = amc.replace(/\s*mutual fund\s*$/i, '').trim(); // "Bank of India Mutual Fund" -> "Bank of India"
  if (core && n.toLowerCase().startsWith(core.toLowerCase())) {
    const rest = n.slice(core.length).replace(/^[\s\-–—]+/, '').trim();
    if (rest) return rest;
  }
  return n;
}

/**
 * Peer group for a fund. Diversified categories keep their category; Sectoral/Thematic funds
 * are routed to a "Thematic: <Theme>" group by the first keyword match in their name (with the
 * AMC name stripped first).
 */
export function derivePeerGroup(category, name, amc) {
  if (category !== 'Sectoral/Thematic') return category;
  const n = stripAmc(name, amc).toLowerCase();
  for (const [theme, re] of THEME_MAP) {
    if (re.test(n)) return `Thematic: ${theme}`;
  }
  return 'Thematic: Other';
}

/** True for the Sectoral/Thematic-derived groups (handy for the UI to group them separately). */
export function isThematicGroup(peerGroup) {
  return typeof peerGroup === 'string' && peerGroup.startsWith('Thematic:');
}
