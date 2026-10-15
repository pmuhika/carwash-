import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web (Netlify): base "/" so SPA routing + assets resolve correctly.
// Electron desktop builds still work with file protocol when loading dist/index.html.
export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    cssCodeSplit: true,
    minify: "esbuild",
  },
});
