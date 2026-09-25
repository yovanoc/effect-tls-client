import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/browser/index.ts"],
  outDir: "dist",
  format: "esm",
  clean: true,
  sourcemap: true,
  dts: true,
  deps: {
    neverBundle: ["effect", "effect/*"],
  },
});
