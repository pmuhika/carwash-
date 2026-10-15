/**
 * Preload — desktop API bridge
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("barposDesktop", {
  isDesktop: true,
  platform: process.platform,
  printHtml: (html, options) =>
    ipcRenderer.invoke("barpos:print-html", html, options || {}),
  getLoginItem: () => ipcRenderer.invoke("barpos:get-login-item"),
  setLoginItem: (openAtLogin) =>
    ipcRenderer.invoke("barpos:set-login-item", openAtLogin),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("barpos:update-status", handler);
    return () => ipcRenderer.removeListener("barpos:update-status", handler);
  },
});
