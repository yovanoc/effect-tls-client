import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "browser/index": "src/browser/index.ts",
    "challenges/aws-waf": "src/challenges/AwsWaf.ts",
  },
  outDir: "dist",
  format: "esm",
  clean: true,
  sourcemap: true,
  dts: true,
  deps: {
    neverBundle: ["effect", "effect/*"],
  },
});
