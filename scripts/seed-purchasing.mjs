// Load a purchase-order costing workbook (like "PURCHASE ORDER FOB - Sep 2026.xlsx") into a company:
// HS codes, the vendor, products (from the PO lines plus the Sheet1 product list), the PO itself,
// and the PO settings (buyer details, charge heads, terms) if none are saved yet.
//
// Before writing it runs the app's own calculation (the PURCHASING-CALC block in public/index.html)
// on the PO and stops if any line's landed cost or selling price differs from the workbook.
//
//   node seed-purchasing.mjs ../serviceAccount.json alfa "<path to .xlsx>"           (check only)
//   node seed-purchasing.mjs ../serviceAccount.json alfa "<path to .xlsx>" --write   (check, then write)
// Re-running is safe: documents have fixed ids and are overwritten, not duplicated.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [keyPath, companyId, xlsxPath, flag] = process.argv.slice(2);
if (!keyPath || !companyId || !xlsxPath) {
  console.error('Usage: node seed-purchasing.mjs <serviceAccount.json> <alfa|muzaf> <workbook.xlsx> [--write]');
  process.exit(1);
}

// ---------- minimal .xlsx reader (cached values only) ----------
function readXlsx(path) {
  const buf = readFileSync(path);
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const files = {};
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0, n = buf.readUInt16LE(eocd + 10); i < n; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nl);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + size);
    files[name] = () => (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    p += 46 + nl + el + cl;
  }
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared = [...(files['xl/sharedStrings.xml']?.() || '').matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map(m => unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const wb = files['xl/workbook.xml'](), rels = files['xl/_rels/workbook.xml.rels']();
  const sheets = {};
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`));
    const xml = files['xl/' + (target[1] || target[2]).replace(/^\/?xl\//, '')]();
    const cells = {};
    for (const c of xml.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      let v = c[3]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (v === undefined) v = c[3]?.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1];
      if (v === undefined) continue;
      cells[c[1]] = /t="s"/.test(c[2]) ? shared[+v] : unesc(v);
    }
    sheets[unesc(m[1])] = cells;
  }
  return sheets;
}

const sheets = readXlsx(xlsxPath);
const po = sheets['Purchase Order'];
if (!po) { console.error('No "Purchase Order" sheet in the workbook.'); process.exit(1); }
const s = ref => String(po[ref] ?? '').trim();
const n = ref => (po[ref] === undefined || po[ref] === '' ? '' : Number(po[ref]));
const clean = x => String(x || '').replace(/\s+/g, ' ').trim();
const cap = x => (x ? x[0].toUpperCase() + x.slice(1) : x);
const slug = x => clean(x).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const excelDate = serial => new Date(Math.round((Number(serial) - 25569) * 86400000)).toISOString().slice(0, 10);

// ---------- master data ----------
const HS = {
  '84251110': 'Pulley tackle and hoists, electric',
  '84251910': 'Pulley tackle and hoists, hand operated (chain blocks)',
  '84253100': 'Winches, electric',
  '84279000': 'Other trucks: pallet trucks, stackers, engine cranes',
  '84311090': 'Parts of heading 8425 machinery',
  '84312090': 'Parts of heading 8427 machinery',
};
const APTA_CODES = ['84251110', '84251910', '84253100']; // the workbook's APTA formula
const hscodes = Object.entries(HS).map(([code, description]) => ({
  code, description, bcd: 7.5, apta: APTA_CODES.includes(code) ? 40 : 0, sws: 10, igst: 18,
}));

const vendorId = 'ven_' + slug(s('H5')).slice(0, 40);
const vendor = {
  name: s('H5'), contact: '', phone: s('H9') || s('H6'), email: s('H8'), address: s('H7'), country: s('H10'),
  currency: s('B8') || 'USD', port: s('B10'), paymentTerms: s('B7'),
};

const poNumber = s('B5');
const MARKUPS = [20, 25, 30];
const ceil5 = x => Math.ceil(x / 5 - 1e-9) * 5;
const lines = [], products = new Map();
let item = '';
for (let r = 13; r <= 200; r++) {
  if (s('A' + r) === 'TOTALS') break;
  if (s('B' + r)) item = cap(clean(s('B' + r)));
  if (n('D' + r) === '' || n('E' + r) === '') continue;
  const spec = clean(s('C' + r));
  const productId = 'prd_' + slug(item + ' ' + spec);
  const line = {
    productId, item, spec, qty: n('D' + r), price: n('E' + r),
    nw: n('G' + r), gw: n('H' + r), vol: n('I' + r), hs: s('P' + r),
  };
  // Selling prices typed or adjusted by hand in the workbook become overrides.
  const unit = Number(po['W' + r]);
  line.sp = ['X', 'Y', 'Z'].map((col, k) => {
    const v = Number(po[col + r]);
    return Math.abs(v - ceil5(unit * (1 + MARKUPS[k] / 100))) > 0.001 ? v : null;
  });
  line.excel = { landed: Number(po['V' + r]), sp: ['X', 'Y', 'Z'].map(c => Number(po[c + r])) };
  lines.push(line);
  products.set(productId, {
    name: item, spec, hs: line.hs, nw: line.nw === '' ? null : line.nw, gw: line.gw === '' ? null : line.gw,
    vol: line.vol === '' ? null : line.vol, lastPrice: line.price, lastPo: poNumber,
  });
}

// Sheet1 product names that are not already PO lines (matched by hand against this workbook).
const EXTRA = [
  'GCT Gear Trolley (Double Stud) 1T × 3M', 'GCT Gear Trolley (Double Stud) 2T × 3M', 'GCT Gear Trolley (Double Stud) 3T × 3M',
  'Ratchet Lever Bare Block 0.75T', 'Electric Winch (3-Phase) 5T × 100M', 'Electric Clutch Winch 1T × 100M × 8mm',
  'Mini Frame 1000kg × 95kg', 'DHS 1P 2T × 6M', 'DHS 1P 3T × 6M', 'DHS 3P 1T × 6M', 'DHS 3P 2T × 6M', 'DHS 3P 3T × 6M',
  'CD1 Hoist with Trolley 5T × 9M', 'Mini Hoist with Trolley PA 1000 × 20M × 6mm', 'Mini Hoist with Trolley PA 500 × 20M × 6mm',
  'Spare - Gearbox cover back', 'Spare - Gear set', 'Spare - Mini frame bracket', 'Spare - Mini frame support rod',
];
const sheet1 = Object.values(sheets['Sheet1'] || {}).map(clean);
for (const name of EXTRA) {
  if (!sheet1.some(x => slug(x) === slug(name))) console.warn('  note: not found in Sheet1:', name);
  products.set('prd_' + slug(name), { name, spec: '', hs: '', nw: null, gw: null, vol: null, lastPrice: null, lastPo: '' });
}

const charges = [];
for (let r = 2; r <= 30; r++) {
  const label = s('AA' + r);
  if (!label || /^total$/i.test(label)) continue;
  if (label.toUpperCase() === 'OTHER CHARGES LESS GST') continue;
  const nice = { TRNSPRT: 'Transport', CFS: 'CFS', CMC: 'CMC' }[label.toUpperCase()] || cap(label.toLowerCase());
  charges.push({ label: nice, amount: Number(po['AB' + r]) || 0 });
}
const terms = [];
for (let r = 73; r <= 80; r++) if (/^\d+\./.test(s('A' + r))) terms.push(s('A' + r));

const rates = Object.fromEntries(hscodes.map(h => [h.code, { bcd: h.bcd, apta: h.apta, sws: h.sws, igst: h.igst }]));
const poDoc = {
  poNumber, date: excelDate(po.B6), status: 'ordered', vendorId,
  vendor: { name: vendor.name, contact: vendor.contact, address: vendor.address, email: vendor.email, phone: vendor.phone, country: vendor.country },
  paymentTerms: s('B7'), currency: s('B8') || 'USD', deliveryTerms: s('B9'), port: s('B10'),
  rate: Number(po.Q2), freight: Number(po.R2), insurance: 0, claimApta: true,
  charges, lines: lines.map(({ excel, ...l }) => l), terms: terms.join('\n'), rates,
};

// ---------- check the app's calculation against the workbook ----------
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const block = html.slice(html.indexOf('// PURCHASING-CALC-START'), html.indexOf('// PURCHASING-CALC-END'));
const state = { purchasing: { markups: MARKUPS }, hscodes: hscodes.map(h => ({ id: h.code, ...h })) };
const computePO = new Function('state', 'round2', block + '\nreturn computePO;')(state, x => Math.round((x + Number.EPSILON) * 100) / 100);
const calc = computePO(poDoc);
let worst = 0;
lines.forEach((l, i) => {
  const x = calc.rows[i];
  const diffs = [Math.abs(x.landed - l.excel.landed), ...x.sp.map((v, k) => Math.abs(v - l.excel.sp[k]))];
  const d = Math.max(...diffs);
  worst = Math.max(worst, d);
  if (d > 0.01) console.error(`  MISMATCH line ${i + 1} ${l.item} ${l.spec}: app landed ${x.landed.toFixed(2)} vs Excel ${l.excel.landed.toFixed(2)}, SP ${x.sp} vs ${l.excel.sp}`);
});
const fmt = x => x.toLocaleString('en-IN', { maximumFractionDigits: 2 });
console.log(`${poNumber} · ${vendor.name} · ${poDoc.date} · ${lines.length} lines`);
console.log(`  FOB ${fmt(calc.totals.fob)} (Excel ${fmt(Number(po.F70))})  CIF ₹ ${fmt(calc.totals.cifInr)} (Excel ${fmt(Number(po.O70))})`);
console.log(`  BCD ${fmt(calc.totals.bcd)} (Excel ${fmt(Number(po.R70))})  SWS ${fmt(calc.totals.sws)} (Excel ${fmt(Number(po.S70))})  IGST ${fmt(calc.totals.igst)} (Excel ${fmt(Number(po.U70))})`);
console.log(`  Assessable ${fmt(calc.totals.assess)} (Excel ${fmt(Number(po.T70))})  Other charges ${fmt(calc.other)} (Excel ${fmt(Number(po.AB14))})`);
console.log(`  Landed cost ${fmt(calc.totals.landed)} (Excel ${fmt(lines.reduce((t, l) => t + l.excel.landed, 0))})`);
console.log(`  Largest difference on any line's landed cost or selling price: ₹${worst.toFixed(6)}`);
console.log(`  Masters: ${hscodes.length} HS codes, 1 vendor, ${products.size} products (${products.size - EXTRA.length} from PO lines, ${EXTRA.length} from Sheet1); ${charges.length} charge heads; ${lines.filter(l => l.sp.some(v => v !== null)).length} lines with hand-set selling prices`);
if (worst > 0.01) { console.error('STOP: the app does not match the workbook. Nothing written.'); process.exit(1); }

// ---------- write ----------
if (flag !== '--write') { console.log('Check passed. Re-run with --write to save it to ' + companyId + '.'); process.exit(0); }
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();
const base = db.doc(`companies/${companyId}`);
const batch = db.batch();
hscodes.forEach(h => batch.set(base.collection('hscodes').doc(h.code), h));
batch.set(base.collection('vendors').doc(vendorId), vendor);
products.forEach((p, id) => batch.set(base.collection('products').doc(id), p));
const now = new Date().toISOString();
batch.set(base.collection('purchaseOrders').doc('po_' + slug(poNumber)), { ...poDoc, createdAt: now, updatedAt: now });
const settingsRef = base.collection('meta').doc('purchasing');
if (!(await settingsRef.get()).exists) {
  // Buyer block from the workbook header: "BUYER: NAME, address… IEC: … GSTIN: … PAN: … CONTACT: phone, email"
  const text = clean(s('A2')).replace(/^BUYER:\s*/i, '');
  const pick = re => (text.match(re) || [])[1]?.trim() || '';
  const [name, ...addr] = text.split(/\s+IEC:/i)[0].split(',').map(x => x.trim());
  const contact = pick(/CONTACT:\s*(.*)$/i).split(',').map(x => x.trim());
  batch.set(settingsRef, {
    buyer: { name, tagline: s('A3'), address: addr.join(', '), iec: pick(/IEC:\s*(\S+)/i), gstin: pick(/GSTIN:\s*(\S+)/i), pan: pick(/PAN:\s*(\S+)/i), phone: contact[0] || '', email: contact[1] || '' },
    markups: MARKUPS, chargeHeads: charges.map(c => c.label),
    terms: terms.map((t, i) => (i === 0 ? '1. All prices are in USD. Payment as per the payment terms above.' : t)).join('\n'),
  });
  console.log('  PO settings: saved buyer details, markups, charge heads and terms.');
} else {
  console.log('  PO settings: already set, left as they are.');
}
await batch.commit();
console.log(`Written to companies/${companyId}.`);
