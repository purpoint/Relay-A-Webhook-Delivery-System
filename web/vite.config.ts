import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Built into the API's own directory, so Fastify serves the app from the
  // same origin as the API. Same origin means no CORS, no preflight, and one
  // service to deploy instead of two.
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },

  server: {
    port: 5173,
    // During frontend development Vite serves the app and forwards API calls
    // to Fastify, so the browser still sees a single origin and the refresh
    // cookie behaves exactly as it will in production.
    proxy: {
      "/api": { target: "http://localhost:3100", changeOrigin: false },
    },
  },
});
