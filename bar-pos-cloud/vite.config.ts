import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// ELECTRON=1 → relative asset paths so file:// / loadFile works in the desktop app.
// Web (Netlify) keeps base "/" for normal hosting.
const isElectron = process.env.ELECTRON === "1" || process.env.ELECTRON === "true";

export default defineConfig({
  plugins: [react()],
  base: isElectron ? "./" : "/",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: true,
    minify: "esbuild",
  },
});
