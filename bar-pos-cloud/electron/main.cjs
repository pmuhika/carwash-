/**
 * Bar POS — Electron main process
 * - Thermal print via dedicated window
 * - Tray + minimize to tray
 * - Open at login (toggle)
 * - Auto-update when published (electron-updater)
 */
const { app, BrowserWindow, shell, Menu, dialog, ipcMain, Tray, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");

const isDev = !app.isPackaged;

// Required on some Linux setups and when running as root / in CI
try {
  app.commandLine.appendSwitch("no-sandbox");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
} catch {
  /* ignore */
}


let brand = {
  appName: "Bar POS",
  shortName: "Bar POS",
  description: "Bar point of sale",
  windowWidth: 1280,
  windowHeight: 800,
  iconFile: "public/icon-512.png",
};
try {
  brand = { ...brand, ...require("./branding.cjs") };
} catch {
  /* branding.cjs created by: npm run brand */
}

let mainWindow = null;
let tray = null;

function iconPath() {
  const candidates = [
    path.join(__dirname, "..", brand.iconFile || "public/icon-512.png"),
    path.join(__dirname, "..", "public", "icon-512.png"),
    path.join(__dirname, "..", "dist", "icon-512.png"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function printHtml(html, options = {}) {
  return new Promise((resolve) => {
    const printWin = new BrowserWindow({
      width: 360,
      height: 640,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    printWin.loadURL(dataUrl);
    printWin.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        printWin.webContents.print(
          {
            silent: !!options.silent,
            printBackground: true,
            deviceName: options.deviceName || "",
          },
          (success, failureReason) => {
            try {
              if (!printWin.isDestroyed()) printWin.close();
            } catch {}
            resolve({ ok: !!success, reason: failureReason || null });
          },
        );
      }, 250);
    });
    printWin.webContents.on("did-fail-load", () => {
      try {
        if (!printWin.isDestroyed()) printWin.close();
      } catch {}
      resolve({ ok: false, reason: "load_failed" });
    });
  });
}

function createTray() {
  const ico = iconPath();
  const img = ico ? nativeImage.createFromPath(ico) : nativeImage.createEmpty();
  tray = new Tray(img.isEmpty() ? nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ) : img.resize({ width: 16, height: 16 }));
  const name = brand.appName || "Bar POS";
  tray.setToolTip(name);
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open " + name,
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          openAsHidden: false,
        });
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function setupAutoUpdater() {
  if (isDev) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", () => {
      if (mainWindow) {
        mainWindow.webContents.send("barpos:update-status", { status: "available" });
      }
    });
    autoUpdater.on("update-downloaded", () => {
      if (mainWindow) {
        mainWindow.webContents.send("barpos:update-status", { status: "downloaded" });
      }
      dialog
        .showMessageBox(mainWindow, {
          type: "info",
          title: "Update ready",
          message: "A new version has been downloaded.",
          detail: "Restart now to install?",
          buttons: ["Restart", "Later"],
          defaultId: 0,
        })
        .then((r) => {
          if (r.response === 0) autoUpdater.quitAndInstall();
        })
        .catch(() => {});
    });
    autoUpdater.on("error", (err) => {
      console.warn("autoUpdater", err && err.message);
    });
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 8000);
  } catch (e) {
    console.warn("electron-updater not available:", e && e.message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: brand.windowWidth || 1280,
    height: brand.windowHeight || 800,
    minWidth: 900,
    minHeight: 600,
    title: brand.appName || "Bar POS",
    backgroundColor: "#151c2d",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: iconPath(),
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Minimize to tray instead of closing (unless quitting)
  mainWindow.on("close", (e) => {
    if (!app.isQuiting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const u = String(url || "");
    if (!u || u === "about:blank" || u.startsWith("blob:") || u.startsWith("data:")) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 360,
          height: 640,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    shell.openExternal(u);
    return { action: "deny" };
  });

  // Load UI
  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  const distIndex = path.join(__dirname, "..", "dist", "index.html");

  if (isDev) {
    // Prefer Vite dev server; fall back to built dist if server is down
    const tryDev = () => {
      mainWindow.loadURL(devUrl).catch(() => {
        if (fs.existsSync(distIndex)) {
          mainWindow.loadFile(distIndex);
        } else {
          dialog.showErrorBox(
            brand.appName || "Sherehe POS",
            "Dev server is not running and dist/ is missing.\n\nRun:\n  npm run desktop:dev\nor:\n  npm run build && npm run desktop",
          );
        }
      });
    };
    tryDev();
  } else {
    if (!fs.existsSync(distIndex)) {
      dialog.showErrorBox(
        brand.appName || "Sherehe POS",
        "App files missing (dist/index.html).\nReinstall the application or rebuild with:\n  npm run desktop:build",
      );
    } else {
      mainWindow.loadFile(distIndex).catch((err) => {
        dialog.showErrorBox(
          brand.appName || "Sherehe POS",
          "Could not open the app UI:\n" + (err && err.message ? err.message : String(err)),
        );
      });
    }
  }

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("did-fail-load", code, desc, url);
    if (isDev && String(url || "").includes("5173")) {
      if (fs.existsSync(distIndex)) mainWindow.loadFile(distIndex);
    }
  });

  const name = brand.appName || "Bar POS";
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: () => mainWindow.webContents.reload(),
        },
        {
          label: "Print test page…",
          accelerator: "CmdOrCtrl+P",
          click: () => {
            mainWindow.webContents.print({ silent: false, printBackground: true });
          },
        },
        { type: "separator" },
        {
          label: "Start at login",
          type: "checkbox",
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({
              openAtLogin: item.checked,
              openAsHidden: false,
            });
          },
        },
        { type: "separator" },
        {
          label: "Quit " + name,
          accelerator: "CmdOrCtrl+Q",
          click: () => {
            app.isQuiting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "togglefullscreen" },
        { role: "zoomin" },
        { role: "zoomout" },
        { role: "resetzoom" },
        { type: "separator" },
        {
          label: "Toggle Developer Tools",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => mainWindow.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About " + name,
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: name,
              message: name,
              detail:
                (brand.description || "Bar point of sale") +
                "\n\nOffline sales & stock queue · tray · auto-update when published.",
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// Durable offline queue on disk (survives app close)
function queueFile(key) {
  const safe = String(key || "queue").replace(/[^a-z0-9_-]/gi, "");
  return path.join(app.getPath("userData"), `offline-${safe}.json`);
}
ipcMain.handle("barpos:queue-read", async (_e, key) => {
  try {
    const f = queueFile(key);
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn("queue-read", err && err.message);
    return [];
  }
});
ipcMain.handle("barpos:queue-write", async (_e, key, data) => {
  try {
    const f = queueFile(key);
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = Array.isArray(data) ? data : [];
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
    fs.renameSync(tmp, f);
    return true;
  } catch (err) {
    console.warn("queue-write", err && err.message);
    return false;
  }
});

ipcMain.handle("barpos:print-html", async (_event, html, options) => {
  try {
    return await printHtml(String(html || ""), options || {});
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle("barpos:get-login-item", () => {
  return app.getLoginItemSettings();
});

ipcMain.handle("barpos:set-login-item", (_e, openAtLogin) => {
  app.setLoginItemSettings({ openAtLogin: !!openAtLogin, openAsHidden: false });
  return app.getLoginItemSettings();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdater();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    // keep running in tray on Windows/Linux if tray exists
    if (!tray) app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuiting = true;
});
