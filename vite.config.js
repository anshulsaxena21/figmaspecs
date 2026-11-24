import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  base: "/figmaspecs/",
  build: {
    rollupOptions: {
      input: {
        app: resolve(process.cwd(), "index.html"),
        figmaImporter: resolve(process.cwd(), "figma-importer.html")
      }
    }
  }
});
