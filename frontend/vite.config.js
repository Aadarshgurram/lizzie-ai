import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api/chat -> http://127.0.0.1:8000/chat (no CORS setup needed in dev)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
