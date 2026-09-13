import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
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
