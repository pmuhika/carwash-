# Bar POS — Real installable desktop software

Install on a PC like normal software. Customize **name** and **logo**, then build an installer (`.exe` on Windows).

## What you get

- A real Windows installer (or Mac/Linux package)
- Start Menu / desktop shortcut with **your** app name
- **Your** logo as the app icon
- Same features as the web app (sell, stock, offline queue, cloud sync)

## 1. Install Node.js (once per PC you build on)

Download **Node.js 20 LTS** from https://nodejs.org and install it.

## 2. Open the project

Unzip the project folder. Open a terminal **in that folder** (where `package.json` is).

```bash
npm install
```

## 3. Choose your name and logo

Edit the file **`branding.json`**:

```json
{
  "appName": "Safari Lounge POS",
  "shortName": "Safari POS",
  "description": "Point of sale for Safari Lounge",
  "author": "Safari Lounge",
  "appId": "com.safarilounge.pos",
  "iconFile": "public/icon-512.png",
  "windowWidth": 1280,
  "windowHeight": 800
}
```

| Field | Meaning |
|--------|---------|
| `appName` | Name on the window title, installer, and Start Menu |
| `shortName` | Shortcut name |
| `iconFile` | Path to your logo (PNG, ideally **512×512** pixels) |
| `appId` | Unique id (change `yourbar` to your bar name, lowercase, no spaces) |

**To use your own logo:** put a PNG file in the project, e.g. `public/my-logo.png`, then set:

```json
"iconFile": "public/my-logo.png"
```

Apply branding:

```bash
npm run brand
```

## 4. Build the installer (Windows)

```bash
npm run desktop:build:win
```

When it finishes, open the **`release`** folder. You should see something like:

`Safari Lounge POS Setup 1.9.6.exe`

## 5. Install on the till computer

1. Copy the `.exe` to the bar PC  
2. Double-click → install (Next, Next, Finish)  
3. Open the app from the Start Menu  
4. Sign in **once with internet** (loads products)  
5. After that it works **offline**; sales sync when internet returns  

## Other platforms

```bash
npm run desktop:build:mac     # Mac .dmg
npm run desktop:build:linux   # Linux AppImage
```

## Test without building an installer

```bash
npm run dev          # terminal 1
npm run desktop      # terminal 2 — opens the window
```

## Notes

- Build the Windows installer on a **Windows** PC for best results.  
- Windows may warn about an unsigned app → More info → Run anyway.  
- The app still uses your Supabase cloud for multi-device sync; offline selling is built in.  
- Inside the app you can still change bar name / logo URL under **Backup & Settings** (receipt branding). The desktop **icon and installer name** come only from `branding.json`.

## Printer (thermal / receipt)

The desktop app prints through **Windows (or Mac) printer drivers**.

1. Install your thermal printer with the manufacturer driver (or Generic / Text-Only).
2. In Windows: **Settings → Bluetooth & devices → Printers** — confirm it appears.
3. Optional: set it as the **default** printer.
4. In Bar POS, complete a sale → the system print dialog opens → choose the thermal printer → Print.
5. Paper width: in the app go to **Backup & Settings** → receipt paper **80mm** or **58mm**.

### If print does nothing after install on a new PC
- Rebuild/install the **latest** desktop package (v1.9.7+). Older builds blocked receipt popups.
- Menu **File → Print test page…** should open the system dialog.
- Do not block the print dialog; choose the thermal printer once.
- USB printers must be plugged in before opening the app; network printers must be online.
