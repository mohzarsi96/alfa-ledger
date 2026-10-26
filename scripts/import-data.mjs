// One-time import of data-export.json into Firestore.
//
//   cd scripts && npm install
//   node import-data.mjs ../data-export.json ../serviceAccount.json          (dry run: counts only)
//   node import-data.mjs ../data-export.json ../serviceAccount.json --write  (writes to Firestore)
//
// Export shape: { orders: {id: value}, reps: {...}, channels: {...}, meta: {settings, months, expenses} }.
// Doc ids are the keys. A value is either the plain document or wrapped as {id, data, version};
// only `data` is written in the wrapped case.
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [exportPath, keyPath, flag] = process.argv.slice(2);
if (!exportPath || !keyPath) {
  console.error('Usage: node import-data.mjs <data-export.json> <serviceAccount.json> [--write]');
  process.exit(1);
}
const write = flag === '--write';

const data = JSON.parse(readFileSync(exportPath, 'utf8'));

const unwrap = v => (v && typeof v === 'object' && 'data' in v && 'version' in v ? v.data : v);

const writes = [];
for (const col of ['orders', 'reps', 'channels', 'meta']) {
  for (const [id, value] of Object.entries(data[col] || {})) {
    writes.push([`${col}/${id}`, unwrap(value)]);
  }
}

for (const col of ['orders', 'reps', 'channels', 'meta']) {
  console.log(`${col}: ${writes.filter(([p]) => p.startsWith(col + '/')).length}`);
}
if (!write) {
  console.log('Dry run. Re-run with --write to import.');
  process.exit(0);
}

const key = JSON.parse(readFileSync(keyPath, 'utf8'));
initializeApp({ credential: cert(key) });
const db = getFirestore();
console.log(`writing to project: ${key.project_id}`);

// Firestore batches hold at most 500 writes.
for (let i = 0; i < writes.length; i += 400) {
  const batch = db.batch();
  for (const [path, doc] of writes.slice(i, i + 400)) batch.set(db.doc(path), doc);
  await batch.commit();
  console.log(`written ${Math.min(i + 400, writes.length)}/${writes.length}`);
}
console.log('Done.');
