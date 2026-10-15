# Production deploy checklist (Bar POS Cloud)

## 1. Supabase project
1. Create/open project at https://supabase.com/dashboard
2. **Authentication → Providers → Email**: turn **Confirm email OFF** for staff POS logins
3. Copy **Project URL** and **anon public** key into `.env`:
   ```
   VITE_SUPABASE_URL=https://YOUR_REF.supabase.co
   VITE_SUPABASE_ANON_KEY=your_anon_key
   ```

## 2. Database schema (required)
1. Open **SQL Editor**
2. Paste and run the entire file: `supabase/schema.sql`
3. Confirm **Success** (safe to re-run)
4. Optional extras if needed:
   - `supabase/fix-pin-digest.sql` (only if you still use PIN resolve)
   - `supabase/factory-reset.sql` (full wipe function)

## 3. Edge Functions (strongly recommended)
These use the **service role** on the server so admin can create users and reset passwords safely.

### Install CLI (once)
```bash
npm install -g supabase
supabase login
```

### Link project
```bash
cd bar-pos-cloud
supabase link --project-ref YOUR_PROJECT_REF
```
Project ref = Settings → General → Reference ID (e.g. `hesrojwhwintwwnehpvd`).

### Deploy
```bash
supabase functions deploy admin-user
supabase functions deploy pin-login --no-verify-jwt
supabase functions deploy nightly-backup
```

### Verify in Dashboard
**Edge Functions** should list: `admin-user`, `pin-login`, `nightly-backup`.

| Function | Purpose |
|----------|---------|
| `admin-user` | Create staff, reset auth password, soft-delete users |
| `pin-login` | Optional PIN login helper (email/password is primary) |
| `nightly-backup` | Optional scheduled backup helper |

Secrets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically when linked.

## 4. Frontend (GitHub → Netlify)

Repo includes `netlify.toml` so Git deploys use the correct settings.

### Extract the zip correctly
The installable zip contains a **top-level folder** `bar-pos-cloud/`.  
Extract it so you get one folder (not files scattered in Downloads).

### Fix “Page not found” on Netlify
- **Do not** drag-and-drop the source zip or the `src/` folder. Netlify must **build** the site.
- Use GitHub continuous deploy (recommended) **or** run `npm run build` locally and upload only the `dist/` folder.
- `netlify.toml` + `public/_redirects` already SPA-fallback `/*` → `/index.html`.
- If you still see 404: Site configuration → Build & deploy → confirm Publish directory is `dist`, then **Trigger deploy → Clear cache and deploy**.

### Push to GitHub
```bash
cd bar-pos-cloud
git init
git add .
git commit -m "Bar POS Cloud offline + PWA"
git branch -M main
git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
git push -u origin main
```
Repo **root** must contain `package.json`, `netlify.toml`, and `src/`  
(not nested as `bar-pos-cloud/bar-pos-cloud/`).

### Connect Netlify → GitHub
1. Netlify → **Add new site** → **Import an existing project** → GitHub → pick the repo  
2. Build settings come from `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
3. **Before deploy**, set environment variables  
   (Site configuration → Environment variables):

   | Key | Value |
   |-----|--------|
   | `VITE_SUPABASE_URL` | `https://YOUR_REF.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | your anon/publishable key |

4. Deploy (or push a new commit).

### Why direct upload works but GitHub deploy shows setup / “not connected”
- Drag-and-drop of a local `dist/` often already has keys baked in from your PC’s `.env`.
- GitHub builds run on Netlify’s servers and **only** see variables you set in the Netlify UI.
- Vite embeds `VITE_*` at **build** time. Missing vars → setup screen instead of login.
- Fix: add the two variables above → **Deploys → Trigger deploy → Clear cache and deploy**.

### Offline / PWA
`public/sw.js` and manifest are copied into `dist/` automatically.  
HTTPS is provided by Netlify. Open the app once online after deploy so the shell caches.

## 5. First admin user
1. **Authentication → Users → Add user** with email + password  
2. Open the app → sign in  
3. First profile is elevated to admin by schema trigger / first login flow  
4. Create staff from **Users** tab (prefer with `admin-user` function deployed)

## 6. Security notes
- **Remember email** only stores the email on the device — never the password
- Never put **service_role** key in the frontend `.env`
- Factory reset requires re-entering the admin **login password**
- Use Supabase Dashboard → Database → **Backups** for disaster recovery

## 7. Smoke test
- [ ] Admin login with email/password  
- [ ] Remember email pre-fills email only  
- [ ] Create product, receive stock, complete sale  
- [ ] Print thermal receipt (no logo)  
- [ ] Factory reset blocked without correct password  
- [ ] Open app once online, then turn off network — app still loads  
- [ ] Complete a sale offline — status shows Offline / Pending; receipt has OFF- prefix  
- [ ] Restore network — pending sales sync automatically  

## Netlify / GitHub build note

If the deploy fails with `vite: not found`, the build ran before dependencies were installed
(or `NODE_ENV=production` skipped devDependencies). Use:

```
npm install --include=dev && npm run build
```

And set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` so Electron is not downloaded for the website build.
This is already set in `netlify.toml`.

