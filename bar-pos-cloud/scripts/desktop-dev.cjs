/**
 * Dev desktop: start Vite, wait for it, open Electron.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const root = path.join(__dirname, "..");
const vite = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "--host", "127.0.0.1", "--port", "5173"],
  { cwd: root, stdio: "inherit", shell: true, env: process.env },
);

function waitForVite(retries = 60) {
  return new Promise((resolve, reject) => {
    let left = retries;
    const tick = () => {
      const req = http.get("http://127.0.0.1:5173", (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (--left <= 0) reject(new Error("Vite did not start"));
        else setTimeout(tick, 500);
      });
    };
    tick();
  });
}

waitForVite()
  .then(() => {
    const electron = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["electron", "."],
      { cwd: root, stdio: "inherit", shell: true, env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" } },
    );
    electron.on("exit", (code) => {
      vite.kill();
      process.exit(code || 0);
    });
  })
  .catch((e) => {
    console.error(e.message || e);
    vite.kill();
    process.exit(1);
  });

process.on("SIGINT", () => {
  vite.kill();
  process.exit(0);
});
