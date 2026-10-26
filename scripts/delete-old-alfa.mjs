// Delete the pre-companies copy of Alfa's data (root-level orders, reps, channels, meta).
// The app reads companies/alfa now; nothing uses the root copy.
//
// Before deleting it always:
//   1. saves the root data to old-alfa-backup-<timestamp>.json in the project folder (git-ignored)
//   2. checks every root doc also exists under companies/alfa, and stops if any is missing
//
//   node delete-old-alfa.mjs ../serviceAccount.json            (backup + check only)
//   node delete-old-alfa.mjs ../serviceAccount.json --delete   (backup + check, then delete)
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [keyPath, flag] = process.argv.slice(2);
if (!keyPath) {
  console.error('Usage: node delete-old-alfa.mjs <serviceAccount.json> [--delete]');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const backup = {};
const refs = [];
const missing = [];
for (const col of ['orders', 'reps', 'channels', 'meta']) {
  const [src, dst] = await Promise.all([db.collection(col).get(), db.collection(`companies/alfa/${col}`).get()]);
  const dstIds = new Set(dst.docs.map(d => d.id));
  backup[col] = Object.fromEntries(src.docs.map(d => [d.id, d.data()]));
  for (const d of src.docs) {
    refs.push(d.ref);
    if (!dstIds.has(d.id)) missing.push(`${col}/${d.id}`);
  }
  console.log(`${col}: ${src.size} old docs, ${dst.size} in companies/alfa`);
}

const file = new URL(`../old-alfa-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(backup, null, 1));
console.log(`Backup saved: ${decodeURIComponent(file.pathname).replace(/^\/([A-Z]:)/, '$1')}`);

if (missing.length) {
  console.error(`STOP: ${missing.length} old docs are not in companies/alfa (e.g. ${missing.slice(0, 5).join(', ')}). Nothing deleted.`);
  process.exit(1);
}
if (refs.length === 0) {
  console.log('Nothing to delete: the old copy is already gone.');
  process.exit(0);
}
if (flag !== '--delete') {
  console.log(`Check passed. Re-run with --delete to permanently delete the ${refs.length} old docs.`);
  process.exit(0);
}
for (let i = 0; i < refs.length; i += 400) {
  const batch = db.batch();
  for (const ref of refs.slice(i, i + 400)) batch.delete(ref);
  await batch.commit();
}
console.log(`Deleted ${refs.length} old docs. companies/alfa is untouched.`);
