import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API host can be overridden so a worktree (or a second checkout)
// can run against its own backend instead of the default port.
// `process` is not typed in this project (no @types/node), so the env
// lookup is done through Vite's own `loadEnv`-free helper: Vite exposes
// the runtime env on `import.meta.env` only for VITE_* keys, hence the
// guarded global lookup.
const envApiTarget =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.KONTUR_API_TARGET;
const apiTarget = envApiTarget ?? "http://127.0.0.1:8000";

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
    // The Arena preview is served through a generated *.e2b.app host.
    // Vite's host allow-list would otherwise reject it with HTTP 403.
    allowedHosts: true,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
  },
});
