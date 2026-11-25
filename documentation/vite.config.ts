import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { publicArtifacts } from "./plugins/content.ts";
import { APP_NAME } from "../frontend/src/utils/brand.ts";

export default defineConfig({
  base: "/docs/",
  plugins: [
    {
      name: "app-name-html",
      transformIndexHtml: {
        order: "pre",
        handler: (html: string) => html.replaceAll("%APP_NAME%", APP_NAME),
      },
    },
    fumadocsMdx({ macro: { include: ["**/src/source.ts"] } }),
    react(),
    tailwindcss(),
    publicArtifacts(),
  ],
  resolve: { dedupe: ["react", "react-dom", "react-router"] },
  ssr: { noExternal: ["fumadocs-core", "fumadocs-ui"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
