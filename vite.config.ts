import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiOrigin = process.env.FEEDFOLD_DEV_API_ORIGIN ?? "http://127.0.0.1:43001";
const devPort = Number(process.env.FEEDFOLD_DEV_PORT ?? 45173);
const demoMode = process.env.VITE_FEEDFOLD_DEMO === "true";
const configuredBasePath = process.env.FEEDFOLD_BASE_PATH ?? "/";
if (!configuredBasePath.startsWith("/")) {
  throw new Error("FEEDFOLD_BASE_PATH must start with /");
}
const appBasePath = configuredBasePath === "/" ? "" : configuredBasePath.replace(/\/+$/, "");
const appBaseUrl = `${appBasePath}/`;
const appUrl = (path: string) => `${appBasePath}${path}`;
const appBasePattern = appBasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const apiPathPattern = `${appBasePattern}/(?:api|health)(?:/|$)`;
const stripBasePath = (path: string) => path.slice(appBasePath.length) || "/";
const demoApiPath = fileURLToPath(new URL("./src/demo/api.ts", import.meta.url));
const demoSocialImagePath = fileURLToPath(new URL("./src/demo/assets/og.png", import.meta.url));

function staticDemoPlugin(): Plugin {
  return {
    name: "feedfold-static-demo",
    transformIndexHtml(html) {
      const demoHtml = html.replace(
        "feedfold, a quiet, keyboard-first, self-hosted feed reader.",
        "Explore feedfold, a quiet, keyboard-first feed reader.",
      );
      return demoHtml.replace(
        "</head>",
        [
          '    <link rel="canonical" href="https://feedfold.com/" />',
          '    <meta property="og:type" content="website" />',
          '    <meta property="og:title" content="feedfold" />',
          '    <meta property="og:description" content="A quiet place for the web you follow." />',
          '    <meta property="og:url" content="https://feedfold.com/" />',
          '    <meta property="og:image" content="https://feedfold.com/og.png" />',
          '    <meta property="og:image:width" content="1730" />',
          '    <meta property="og:image:height" content="909" />',
          '    <meta property="og:image:alt" content="The feedfold reader in its quiet dark theme" />',
          '    <meta name="twitter:card" content="summary_large_image" />',
          "  </head>",
        ].join("\n"),
      );
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "og.png",
        source: readFileSync(demoSocialImagePath),
      });
    },
  };
}

export default defineConfig({
  base: appBaseUrl,
  resolve: {
    alias: demoMode
      ? [
          {
            find: /^(?:\.\.\/|\.\/)api(?:\.js)?$/,
            replacement: demoApiPath,
          },
        ]
      : [],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      manifest: {
        id: appBaseUrl,
        name: "feedfold",
        short_name: "feedfold",
        description: demoMode
          ? "Explore feedfold with a curated, interactive demo."
          : "A quiet, keyboard-first, self-hosted feed reader.",
        start_url: appBaseUrl,
        scope: appBaseUrl,
        display: "standalone",
        categories: ["news", "productivity"],
        background_color: "#0f1211",
        theme_color: "#0f1211",
        icons: [
          {
            src: appUrl("/icons/pwa-192.png"),
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: appUrl("/icons/pwa-512.png"),
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        shortcuts: [
          {
            name: "Unread articles",
            short_name: "Unread",
            url: appUrl("/articles/unread"),
            icons: [{ src: appUrl("/icons/pwa-192.png"), sizes: "192x192" }],
          },
          {
            name: "Saved articles",
            short_name: "Saved",
            url: appUrl("/articles/saved"),
            icons: [{ src: appUrl("/icons/pwa-192.png"), sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,png,webp}"],
        navigateFallback: appUrl("/index.html"),
        navigateFallbackDenylist: [new RegExp(`^${apiPathPattern}`)],
        runtimeCaching: demoMode
          ? []
          : [
              {
                urlPattern: new RegExp(apiPathPattern),
                handler: "NetworkOnly",
              },
            ],
      },
    }),
    ...(demoMode ? [staticDemoPlugin()] : []),
  ],
  root: ".",
  build: {
    outDir: demoMode ? "dist/demo" : "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: devPort,
    strictPort: true,
    proxy: {
      [appUrl("/api")]: {
        target: apiOrigin,
        rewrite: stripBasePath,
      },
      [appUrl("/health")]: {
        target: apiOrigin,
        rewrite: stripBasePath,
      },
    },
  },
});
