import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Colours from the design tokens (packages/ui/src/styles.css): primary ink and the page background.
const INK = "#111113";
const BACKGROUND = "#fbfbfc";

// Built for /app/ (the API serves the staff app there, beside the portal); / in development.
export default defineConfig(({ command }) => {
  const base = command === "build" ? "/app/" : "/";
  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: false,
        includeAssets: ["favicon.svg", "apple-touch-icon.png"],
        manifest: {
          name: "bide Comply",
          short_name: "Comply",
          description: "Your checks for today, offline when you need them.",
          lang: "en-GB",
          start_url: base,
          scope: base,
          display: "standalone",
          orientation: "portrait",
          theme_color: INK,
          background_color: BACKGROUND,
          icons: [
            { src: "icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        workbox: {
          // The app shell only. API responses are never cached by the service worker: today's tasks are kept in
          // IndexedDB by the app itself, and staff documents are never kept offline (§8 Offline).
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          navigateFallback: `${base}index.html`,
          navigateFallbackDenylist: [/^\/api\//],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
        devOptions: { enabled: false },
      }),
    ],
    resolve: {
      alias: { "@": new URL("./src", import.meta.url).pathname },
    },
    server: {
      // Pinned and strict: Google OAuth only accepts registered origins, so a port that moves breaks sign-in.
      port: 5181,
      strictPort: true,
      host: true,
      proxy: {
        "/api": { target: "http://127.0.0.1:8310", changeOrigin: false },
      },
    },
  };
});
