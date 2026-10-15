/**
 * Preload — desktop API bridge (print, login item, durable offline queue files)
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
  queueRead: (key) => ipcRenderer.invoke("barpos:queue-read", key),
  queueWrite: (key, data) => ipcRenderer.invoke("barpos:queue-write", key, data),
  onUpdateStatus: (cb) => {
    const handler = (_e, data) => cb && cb(data);
    ipcRenderer.on("barpos:update-status", handler);
    return () => ipcRenderer.removeListener("barpos:update-status", handler);
  },
});
