/**
 * Build the web UI with relative base paths for Electron (file protocol).
 */
const { spawnSync } = require("child_process");
const path = require("path");

const env = { ...process.env, ELECTRON: "1" };
const r = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "build"],
  { env, stdio: "inherit", shell: true, cwd: path.join(__dirname, "..") },
);
process.exit(r.status || 0);
