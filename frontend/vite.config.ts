import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend runs on :8000 (make demo); the dev server forwards /api to it.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8000" },
  },
});
