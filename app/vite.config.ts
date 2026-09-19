import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { threeGuard } from "./server/build-three-guard.ts";

export default defineConfig({
  root: "web",
  // Garde de three.js (L32, D-3d-06) : licence émise, taille journalisée, build en échec sur eval, new Function, modules
  // three interdits ou three importé statiquement.
  plugins: [react(), threeGuard()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Développement : l'API tourne sur le serveur du cockpit (npm run dev:server).
    proxy: {
      "/api": { target: "http://127.0.0.1:7777", changeOrigin: false },
      "/auth": { target: "http://127.0.0.1:7777", changeOrigin: false },
    },
  },
});
