/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The console talks to the existing FastAPI service through the versioned
 * mirror at `/api/v1`. In development Vite proxies that prefix to the Python
 * server, so the browser stays same-origin and no CORS relaxation is needed
 * beyond what the backend already ships.
 *
 * Extra hostnames (for example a Cloud preview domain) are passed in through
 * the environment at start time and never hard-coded here:
 *   PREVIEW_HOST=foo.example.dev npm run dev -- --host 0.0.0.0
 */
const apiTarget = process.env.NEURAL_API_URL ?? "http://127.0.0.1:8000";

const extraHosts = (process.env.PREVIEW_HOST ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT ?? 5173),
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1", ...extraHosts],
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        timeout: 300_000,
        // The job progress socket lives under the same prefix.
        ws: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    outDir: "dist",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
