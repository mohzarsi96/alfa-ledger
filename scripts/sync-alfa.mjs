// Moving to multiple companies: mirror Alfa's root-level data into companies/alfa,
// and give each user's old tab list (users/{uid}.pages) to Alfa (access.alfa).
// Safe to re-run: companies/alfa ends up an exact copy of the root data
// (docs missing at the root are removed from the copy). The root data is not touched.
//
//   node sync-alfa.mjs ../serviceAccount.json           (dry run: counts only)
//   node sync-alfa.mjs ../serviceAccount.json --write
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const [keyPath, flag] = process.argv.slice(2);
if (!keyPath) {
  console.error('Usage: node sync-alfa.mjs <serviceAccount.json> [--write]');
  process.exit(1);
}
const write = flag === '--write';
initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const db = getFirestore();

const ops = []; // [kind, ref, data]
for (const col of ['orders', 'reps', 'channels', 'meta']) {
  const [src, dst] = await Promise.all([db.collection(col).get(), db.collection(`companies/alfa/${col}`).get()]);
  const srcIds = new Set(src.docs.map(d => d.id));
  for (const d of src.docs) ops.push(['set', db.doc(`companies/alfa/${col}/${d.id}`), d.data()]);
  const stale = dst.docs.filter(d => !srcIds.has(d.id));
  for (const d of stale) ops.push(['delete', d.ref]);
  console.log(`${col}: ${src.size} to copy, ${stale.length} to remove from the copy`);
}

const users = await db.collection('users').get();
for (const u of users.docs) {
  const { pages, access } = u.data();
  if (Array.isArray(pages) && !(access && access.alfa)) {
    ops.push(['update', u.ref, { 'access.alfa': pages }]);
    console.log(`user ${u.data().email}: Alfa tabs = ${pages.join(', ') || '(none)'}`);
  }
}

if (!write) {
  console.log('Dry run. Re-run with --write to apply.');
  process.exit(0);
}
for (let i = 0; i < ops.length; i += 400) {
  const batch = db.batch();
  for (const [kind, ref, data] of ops.slice(i, i + 400)) {
    if (kind === 'set') batch.set(ref, data);
    else if (kind === 'update') batch.update(ref, data);
    else batch.delete(ref);
  }
  await batch.commit();
}
console.log(`Done: ${ops.length} writes.`);
