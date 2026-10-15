import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Service worker → offline app shell
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    if (import.meta.env.DEV) {
      // Dev: unregister so Vite HMR is not blocked
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister());
      });
      return;
    }
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      })
      .catch((err) => console.warn("SW registration failed:", err));
  });
}

const boot = document.getElementById("offline-boot");
if (boot) boot.classList.remove("show");
