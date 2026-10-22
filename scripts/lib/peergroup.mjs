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
export function stripAmc(name, amc) {
  const n = (name || '').trim();
  if (!amc) return n;
  const core = amc.replace(/\s*mutual fund\s*$/i, '').trim(); // "Bank of India Mutual Fund" -> "Bank of India"
  if (core && n.toLowerCase().startsWith(core.toLowerCase())) {
    const rest = n.slice(core.length).replace(/^[\s\-–—]+/, '').trim();
    if (rest) return rest;
  }
  return n;
}

// Passive INDEX funds get their own peer groups so "vs category" compares like with like (an
// index fund vs its own segment, never against active funds). FIRST match wins, so the more
// specific signals — international and factor/smart-beta tilts — are tested BEFORE the plain cap
// buckets (e.g. "Nifty Midcap 150 Momentum 50" is a factor fund, not a mid-cap fund).
export const INDEX_GROUP_MAP = [
  ['International', /nasdaq|s&\s*p\s*500|hang\s*seng|\bglobal\b|\bworld\b|developed|\bmsci\b|\bfang\b|\bnyse\b|emerging|\bchina\b|\bjapan\b|overseas/],
  ['Factor / Smart-Beta', /momentum|\bvalue\b|quality|\balpha\b|low\s*vol|volatility|equal\s*weight|\bfactor\b|multi[-\s]?factor|enhanced|\bedge\b|growth sector/],
  ['Sectoral', /\bbank\b|banking|financ|\bbfsi\b|finserv|\bit\b|niftyit|infotech|technolog|\bdigital\b|internet|pharma|health|\bauto\b|\bev\b|mobility|\bfmcg\b|consum|\binfra|\benergy\b|\bpower\b|\bpsu\b|\bmetal|commodit|realty|\breit|\bmedia\b|\boil\b|\bgas\b|chemical|manufactur|defence|defense|railway|insurance|capital market|private bank|consumer durable|tourism|housing|logistics|transport/],
  ['Mid & Small Cap', /midcap|mid\s*cap|smallcap|small\s*cap|midsmall|mid\s*&?\s*small|microcap|micro\s*cap/],
  ['Large Cap', /nifty\s*50\b|nifty50\b|nifty\s*index|next\s*50|nifty\s*100\b|nifty100\b|sensex|large\s*cap|largecap|\btop\s*\d+\b/],
  ['Broad Market', /nifty\s*200\b|nifty\s*500\b|nifty500\b|bse\s*500|bse\s*1000|total\s*market|multicap|multi\s*cap|\b750\b|\b1000\b/],
];

/** Index-fund peer group from the (AMC-stripped) scheme name. */
export function deriveIndexPeerGroup(name) {
  const n = (name || '').toLowerCase();
  for (const [group, re] of INDEX_GROUP_MAP) if (re.test(n)) return `Index: ${group}`;
  return 'Index: Other';
}

/**
 * Peer group for a fund. Passive index funds are routed to "Index: <Segment>"; diversified
 * categories keep their category; Sectoral/Thematic funds are routed to "Thematic: <Theme>" by
 * the first keyword match in their name (with the AMC name stripped first).
 */
export function derivePeerGroup(category, name, amc) {
  if (category === 'Index Fund') return deriveIndexPeerGroup(stripAmc(name, amc));
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

/** True for the passive index peer groups. */
export function isIndexGroup(peerGroup) {
  return typeof peerGroup === 'string' && peerGroup.startsWith('Index:');
}
