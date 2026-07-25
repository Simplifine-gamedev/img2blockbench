import { defineConfig } from "../../demo/node_modules/vite/dist/node/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export default defineConfig({
  root: repositoryRoot,
  resolve: {
    alias: {
      three: path.join(repositoryRoot, "demo/node_modules/three"),
    },
  },
  server: {
    host: "localhost",
    port: 4174,
    strictPort: true,
    fs: {
      allow: [repositoryRoot],
    },
  },
});
