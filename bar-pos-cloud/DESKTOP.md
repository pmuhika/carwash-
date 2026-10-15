# Sherehe POS — Desktop app (Windows / Mac / Linux)

## Why the window did not open before (fixed in this package)

1. **Asset paths** — web build used absolute `/assets/...` paths. Electron loads files from disk, so those broke. Desktop builds now use **relative** paths (`./assets/...`).
2. **`npm run desktop` alone** — opens Electron without the UI server and without a built `dist/`. Use **`npm run desktop:dev`** (dev) or build first.
3. **`"type": "module"`** in package.json — removed so Electron’s CommonJS main process loads cleanly.
4. **Linux / sandbox** — Electron now starts with `--no-sandbox` where needed so the process does not exit immediately.

## Quick start (Windows)

### 1. Install Node.js 20 LTS
https://nodejs.org → install → restart the PC if asked.

### 2. Unzip this project
Open the `bar-pos-cloud` folder in **Command Prompt**:
- Open the folder → click the address bar → type `cmd` → Enter

### 3. Install dependencies
```bat
npm install
```

### 4. Apply logo / name
```bat
npm run brand
```

### 5A. Try the app (development — recommended first test)
```bat
npm run desktop:dev
```
This starts Vite **and** Electron together. A window should open with Sherehe POS.

### 5B. Build a real Windows installer
```bat
npm run desktop:build:win
```
When finished, open the **`release`** folder and run:
`Sherehe POS Setup ….exe`

Install on the till, then open **Sherehe POS** from the Start Menu.

## Other useful commands

| Command | What it does |
|---------|----------------|
| `npm run desktop:dev` | Dev mode (Vite + Electron) — **use this to test** |
| `npm run build:electron` or `node scripts/build-electron.cjs` | Build UI for Electron only |
| `npm run desktop:build:win` | Brand + build UI + Windows installer |
| `npm run desktop` | Electron only (needs `dist/` already built, or Vite running) |

## If the window is blank

1. Run `npm run desktop:dev` (not only `npm run desktop`).
2. Or run:
   ```bat
   node scripts/build-electron.cjs
   npm run desktop
   ```
3. Press **Ctrl+Shift+I** in the app → Console tab → send any red errors if it still fails.

## Updates

- **Sales / stock / products** sync from Supabase automatically.
- **New features / UI** need a **new desktop build** (or GitHub Releases auto-update when configured).

## Notes

- Build the Windows `.exe` on a **Windows** PC when possible.
- Windows SmartScreen may warn on unsigned apps → More info → Run anyway.
- Keep `.env` with your Supabase URL and anon key before building.
