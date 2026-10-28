import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    // Pinned and strict: Google OAuth only accepts registered origins, so a port that moves breaks sign-in.
    port: 5180,
    strictPort: true,
    proxy: {
      // Same origin in development: cookies work, no CORS, no absolute URLs in the client.
      "/api": { target: "http://127.0.0.1:8310", changeOrigin: false },
    },
  },
})
