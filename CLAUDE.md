# Alfa Enterprises — Sales & Incentive Ledger

Single-file web app (`public/index.html`, formerly `app.html`; plain HTML/JS, Chart.js + SheetJS from CDN). It was built as a Claude artifact
that uses an artifact database client (`db.collection(..).doc(..).set/update/delete`, `db.doc('meta/..')`, `onSnapshot`).
Goal of this project: host it on Firebase (Firestore + Auth + Hosting) under the company's own domain, deploy via GitHub.

## Migration tasks
1. Replace the artifact `db` / `downloads` capability calls in `public/index.html` with Firebase Firestore (modular SDK) + file download via Blob.
   The Firestore API shape is nearly identical (collections/docs/onSnapshot).
2. Add email/password login (Firebase Auth). Firestore rules: only signed-in users read/write.
3. Import `data-export.json` (collections: orders, reps, channels, meta/{settings,months,expenses}). Doc ids = the keys; each value has `id`, `data`, `version`: write only `data`.
4. firebase.json + Hosting + GitHub Actions deploy (`firebase init hosting:github`). Keep the repo private.
5. Keep the UI exactly as is (60-30-10 blue/slate/amber theme).

## Data model (Firestore)
Two companies share the app and the users: Alfa Enterprises (`alfa`) and Muzaf Enterprise (`muzaf`), listed in `COMPANIES` in public/index.html. Company data lives under `companies/{companyId}/` (orders, reps, channels, meta); the paths below are relative to that. Picked on the sign-in screen, switched from the sidebar.
- `orders/{id}`: ref, channel, rep, ledgerMonth ('YYYY-MM'), gstRate, grossSales, totalCost (null if pending),
  paymentStatus ('none'|'full'|'noteligible'), incentiveMonth ('YYYY-MM' or null; set when carried over),
  incentiveLocked (bool), notes
- `reps/{code}` {code,name}; `channels/{code}` {code,name}
- `users/{uid}` (root, shared) {email,name,role:'admin'|'user',access:{companyId:[tab ids]},active}: access record; no tabs for a company = no access to it. Admins add users and set tabs in the Users tab; firestore.rules require an active users doc and gate writes by tab. Recovery/first admin: `node scripts/set-access.mjs serviceAccount.json <email> admin`.
- `meta/settings` {incentiveRate:5}; `meta/months` {list:[...]}; `meta/expenses` {salaries,rent,electricity,fuel,marketing,other}

## Business rules
- Gross sales and total cost include GST. Gross profit = gross − cost. Net profit = gross profit / (1 + GST%/100). GST is 18% or 5% (blank in bulk upload = 0%).
- Incentive = 5% of net profit, only for orders with status "Payment received"; counted in the order's incentive month (carry over moves it to next month; push back reverses).
- Salesmen with code/name F and M are owners: never eligible. New salesmen are eligible automatically.
- A received order is locked (lock icon) to prevent double issuance; it must be unlocked before its status can change.
- Financial year = Indian FY (1 Apr – 31 Mar).
- Channel SR = Lifting business; every other channel = Glass business.
- True net profit = total net profit − (monthly expenses total × number of months that have orders).
- Bulk upload template columns: Order Ref, Channel, Salesman, Month (YYYY-MM or 1-12), GST %, Gross Sales, Total Cost, Notes. Parse dates from raw Excel serials (no `cellDates`; IST timezone bug).
