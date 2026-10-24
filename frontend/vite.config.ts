import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The production bundle is served by FastAPI from /static (strict CSP:
// script-src 'self', style-src 'self'). Therefore:
//  - base points at the mounted static dir,
//  - output lands in ../static/app so the existing Python Docker image
//    (COPY static) and docker-compose volume keep working unchanged,
//  - the modulepreload polyfill is disabled because Vite would inject it
//    as an inline <script>, which the CSP forbids.
export default defineConfig({
  plugins: [react()],
  base: "/static/app/",
  build: {
    outDir: "../static/app",
    emptyOutDir: true,
    modulePreload: false,
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (/node_modules\/(@material\/web|lit|lit-html|lit-element|@lit|@lit-labs|tslib)\//.test(id))
            return "material";
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
});
