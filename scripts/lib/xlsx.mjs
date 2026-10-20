// xlsx.mjs — a tiny, zero-dependency .xlsx reader (ZIP container + the few XML parts we need).
//
// An .xlsx is a ZIP of XML. We parse the central directory, inflate the entries we care about
// (xl/sharedStrings.xml, xl/workbook.xml, xl/worksheets/*.xml) with Node's built-in zlib, and
// turn each worksheet into a 2-D array of cell values. Enough for AMC portfolio disclosures;
// not a general-purpose Excel engine.

import { inflateRawSync } from 'node:zlib';

// --- ZIP ---------------------------------------------------------------------
function readZip(buf) {
  // Locate End Of Central Directory (scan back for signature 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  let n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let e = 0; e < n; e++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // Jump to the local header to find where the data actually starts.
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    off += 46 + nameLen + extraLen + commLen;
  }
  return files;
}

// --- minimal XML helpers -----------------------------------------------------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const si of xml.split('</si>')) {
    if (!si.includes('<si')) continue;
    // concatenate every <t>…</t> in the string item (covers rich text runs)
    const texts = [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]));
    out.push(texts.join(''));
  }
  return out;
}

const colToIdx = (ref) => {
  const m = ref.match(/^([A-Z]+)/);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
};

function parseSheet(xml, ss) {
  const rows = [];
  for (const rowXml of xml.split('</row>')) {
    if (!rowXml.includes('<row')) continue;
    const row = [];
    for (const m of rowXml.matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>|<c\s+r="([A-Z]+\d+)"([^>]*)\/>/g)) {
      const ref = m[1] || m[4];
      const attrs = m[2] || m[5] || '';
      const inner = m[3] || '';
      const ci = colToIdx(ref);
      let val = null;
      const t = (attrs.match(/t="([^"]+)"/) || [])[1];
      if (t === 's') { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; if (v != null) val = ss[+v]; }
      else if (t === 'inlineStr') { const v = (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]; if (v != null) val = decode(v); }
      else { const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1]; if (v != null) val = isNaN(+v) ? decode(v) : +v; }
      row[ci] = val;
    }
    rows.push(row);
  }
  return rows;
}

/** Parse an .xlsx Buffer into { sheets: [{ name, rows }] }. rows are arrays of cell values. */
export function readXlsx(buf) {
  const files = readZip(buf);
  const ss = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const wb = files.get('xl/workbook.xml')?.toString('utf8') || '';
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relMap = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relMap.get(m[2]);
    const path = target ? (target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '')) : null;
    const xml = path && files.get(path)?.toString('utf8');
    if (xml) sheets.push({ name: decode(m[1]), rows: parseSheet(xml, ss) });
  }
  return { sheets };
}
