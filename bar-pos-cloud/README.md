## Production deploy

See **[DEPLOY.md](./DEPLOY.md)** for schema + Edge Functions checklist.

# Bar POS Cloud v1.9.8 (offline)

A cloud-synced bar point-of-sale built with React + TypeScript + Vite and Supabase.  
Currency: Kenyan shillings (KES).

**Offline / PWA**
- Installable Progressive Web App (service worker + manifest).
- After **one online visit** following deploy, the full app shell (HTML/JS/CSS) loads with no internet.
- Sales continue offline; they queue on the device and sync when connectivity returns.
- Status bar: Live / Offline / Pending N.

**Highlights**
- Role-aware Dashboard (admin sees sales, gross/net profit, expenses, credit, items sold, low-stock alerts & reprint; cashier sees own sales, low stock, items sold & reprint)
- Sell screen: products grouped Beer → Spirits → Soft Drinks first, sorted by SKU ascending; cash / M-Pesa / card / credit; hold sale; creditor name required for credit; thermal receipt popup after payment
- Receive Stock & Inventory: same category/SKU layout; click card → modal (qty + total cost + optional supplier/receipt for receive; physical count for audit). Barrel products convert automatically (1 barrel = units_per_pack cups)
- Products: image, SKU, prices, low-stock warning, category, barrel support, XLSX import/export, Delete-all protected by admin PIN
- Credits: grouped by creditor name, outstanding balance, partial payments with receipt, history; cashiers only see open balances
- Expenses, Reports (CSV export), Users guidance, Activity Log, Backup & Settings (bar name, logo URL, till number, receipt footer, admin PIN, factory reset)

## Requirements
- Node.js 20+ recommended
- A Supabase project

## 1. Set up the database
1. Create a Supabase project at https://supabase.com/dashboard.
2. Open **SQL Editor → New query**.
3. Paste and run the complete `supabase/schema.sql` file.
4. In **Authentication → Providers**, enable Email. For a private bar system, turn off public sign-ups after you create the staff accounts you need.

## 2. Configure the frontend
```bash
cp .env.example .env
```
Set the variables in `.env` from **Project Settings → API**:
```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```
Use the publishable/anon key only. **Never put the `service_role` key in frontend code.**

Then run:
```bash
npm install
npm run dev
```
Open the local URL printed by Vite. To verify a production build, run `npm run build`; output is written to `dist/`.

## 3. Create the first admin
1. In Supabase **Authentication → Users**, create a user with the bar owner's email and a strong password.
2. Copy that user's UUID.
3. Run this SQL, replacing the UUID and name:
```sql
update public.profiles
set role = 'admin', full_name = 'Bar Owner', active = true
where id = 'PASTE-AUTH-USER-UUID-HERE';
```
New auth users get a profile with the `cashier` role automatically. Use the same SQL to set up a cashier's name, keep role `cashier`, and set `active = true`.

## What is implemented
- Supabase email/password authentication and persistent sessions.
- Cloud-backed product list, product search, category filtering, and admin-only product creation/editing.
- Cash / M-Pesa / card / credit payment selection, with required creditor name for credit sales.
- Database RPC for checkout: validates inventory, locks rows, decrements stock, writes sale lines and stock movement records in one transaction. Two terminals cannot successfully sell more stock than is available.
- Database RPC for stock receiving (admin-only) and auditable movement records.
- Role-aware dashboard with daily sales, gross/net profit and expenses for admins; cashier daily sales; itemised daily sales, low-stock alerts, and receipt reprinting. Includes category-separated selling screen (Beer, Spirits, Soft Drinks first), SKU ascending order, held sales, thermal receipt preview/printing, and expense entry.
- Row-level security for product visibility, user profiles, and cashier sales visibility.

## Important notes / next build items
- This is an MVP foundation, not a fully audited production system. Before live deployment, add cash-up and shift reconciliation, credit payment/collection tracking, supplier records, stock wastage/adjustment screens, CSV/PDF reports, account management UI, automated tests, and a proper cashier/admin review of RLS policies.
- Gross profit is calculated from the stored sale total less the stored product cost total. Net profit is gross profit less recorded expenses. Credit sales are recorded with the creditor name; credit collection/payment tracking is not yet implemented.
- **Offline sales supported**: After a successful online session, products, settings and profile are cached on the device. When the internet drops, the Sell screen remains usable — sales are recorded locally, stock is deducted optimistically, and a receipt is shown with an OFF- prefix. Queued sales are automatically replayed through the same `checkout_sale` RPC when connectivity returns. The top-bar indicator shows Live / Offline / Pending N. First login still needs internet so the cache can be populated. Stock receive, product edits and user management remain online-only.
- Cashiers can view their own sales; administrators can view all sales. Stock receiving and product maintenance are admin-only. The database enforces these rules for the supplied RPC and table policies.
- Do not enable public sign-ups for an internal POS unless you intentionally want anyone to create an account. Create staff through Supabase Auth dashboard or a future admin user-management screen.

## Deploy to Netlify
1. Push this project to a private GitHub repository.
2. In Netlify, import the repository.
3. Build command: `npm run build`; publish directory: `dist`.
4. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Site configuration → Environment variables.
5. Deploy. Run `npm run build` locally first to catch configuration errors.

## Data integrity
Sales and stock deductions are committed by a Postgres function inside a single database transaction, so a failed checkout rolls back all related changes. Every browser/device reads the shared Supabase database. Do not make direct client-side stock quantity edits; use the stock RPCs so movements are recorded.

## v1.2 bar operations update

This revision adds:
- Separate **Receive Stock** and **Inventory** product-card screens, grouped by category and sorted by SKU.
- Receiving modal with quantity, total delivery cost, optional supplier, optional supplier receipt number, and automatic per-unit cost / weighted average cost update.
- Inventory audit modal that sets the counted stock and writes an adjustment movement.
- Product images, SKU/category/prices/low-stock thresholds, and barrel-to-cup unit conversion (default 100 cups per barrel).
- XLSX product import/export in the Products screen.
- Initial Credits grouping, Expenses list, basic report totals and CSV export.
- Database extensions in `supabase/schema.sql` for product packaging metadata, stock receipt records, and guarded stock-adjustment/receiving RPCs.

**Important scope note:** this is still an in-progress POS build. The Credits page currently groups the original credit-sale amounts; it does not yet record settlements or calculate outstanding balances after partial payments. The Users page does not yet create accounts or enforce per-tab permissions. Activity Log currently relies on the stock movement table rather than a complete unified audit feed. Settings, logo/receipt customization, PIN-protected factory reset, advanced daily/weekly/monthly charts, best/worst-seller reports, and Excel report export are not complete. Do not treat these unfinished pages as active controls.

For an existing Supabase database, run the updated complete `supabase/schema.sql` in the SQL Editor before running this frontend. Back up your database first. Frontend build verification could not be completed in the authoring environment because dependency installation timed out; run `npm install` and `npm run build` locally and fix any environment-specific errors before using it for live transactions.

## v1.7 improvements

### Apply database updates
Run the full `supabase/schema.sql` (or at least the **v1.7** section at the end) in the Supabase SQL Editor.

### Edge Functions (recommended for secure admin + PIN sync)
```bash
# From project root with Supabase CLI logged in
supabase functions deploy admin-user
supabase functions deploy nightly-backup
# Set secrets if not auto-injected:
# SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL
```
Schedule `nightly-backup` in Dashboard → Edge Functions → Schedules (e.g. `0 2 * * *`).
Create a private Storage bucket named `backups` (function will try to create it).

### New app behaviour
1. **Secure PIN** — SHA-256 hash (legacy base64 PINs still work until re-set)
2. **Low stock** — banner on Sell, vibration, optional block out-of-stock sales
3. **Receipts** — thermal print + WhatsApp share; till/cashier on receipt
4. **My sales today** — cashiers see only their sales with reprint/WhatsApp
5. **Idle timeout** — configurable 1–60 minutes in Backup & Settings
6. **Admin Edge Function** — create user / reset PIN / delete with service role
7. **Backup** — Download full JSON; optional nightly Storage backup
8. **Multi-till stock** — clearer “stock changed on another till” errors + auto refresh
9. **Profit reports** — by category and by product
10. **Faster sell** — favorites (★), qty steppers, hold sale (existing)
