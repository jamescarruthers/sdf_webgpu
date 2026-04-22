import { defineConfig } from "vite";

// VITE_BASE is set by the GitHub Pages workflow to "/<repo>/" so built asset
// URLs resolve under the project-page subpath. Local dev defaults to "/".
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  server: {
    port: 5173,
  },
  assetsInclude: ["**/*.wgsl"],
});
