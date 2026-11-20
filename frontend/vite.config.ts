import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The contract puts the backend on 8010. API_TARGET overrides it for a machine where
// that port is already taken (e.g. `API_TARGET=http://localhost:8001 npm run dev`).
const apiTarget = process.env.API_TARGET ?? "http://localhost:8010";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});
