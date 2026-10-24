import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the API is proxied to whichever backend runs locally —
// Python on :8000 or the Go experiment on :8080 (set VITE_API_TARGET).
const target = process.env.VITE_API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/metrics": { target, changeOrigin: false },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/metrics": { target, changeOrigin: false },
    },
  },
});
