// Give an existing sign-in account access to the ledger, from outside the app.
// Use it to create the first admin, or to recover if no admin can sign in.
//
//   node set-access.mjs ../serviceAccount.json someone@example.com admin
//   node set-access.mjs ../serviceAccount.json someone@example.com user    (all tabs in every company; trim them in the Users tab)
import { readFileSync } from 'node:fs';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Keep in sync with COMPANIES and the non-admin entries of PAGES in public/index.html.
const COMPANIES = ['alfa', 'muzaf'];
const ALL_TABS = ['dashboard', 'orders', 'pnl', 'channels', 'salesmen', 'incentives', 'monthly', 'expenses', 'settings'];

const [keyPath, email, role] = process.argv.slice(2);
if (!keyPath || !email || !['admin', 'user'].includes(role)) {
  console.error('Usage: node set-access.mjs <serviceAccount.json> <email> admin|user');
  process.exit(1);
}

initializeApp({ credential: cert(JSON.parse(readFileSync(keyPath, 'utf8'))) });
const user = await getAuth().getUserByEmail(email);
const ref = getFirestore().doc(`users/${user.uid}`);
const existing = (await ref.get()).data() || {};

await ref.set({
  email: user.email,
  name: existing.name || user.displayName || user.email.split('@')[0],
  role,
  access: Object.fromEntries(COMPANIES.map(c => [c, role === 'admin' ? [] : ALL_TABS])),
  active: true,
  createdAt: existing.createdAt || new Date().toISOString(),
}, { merge: true });
console.log(`${user.email} (${user.uid}) is now an active ${role}.`);
