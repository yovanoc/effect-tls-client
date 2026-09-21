import { baseConfig } from "./packages/oxlint-config/base.ts";
import { defineConfig } from "oxlint";

export default defineConfig({
  env: { builtin: true, node: true },
  extends: [baseConfig],
  // CLI scripts mix setup, validation, and subprocess orchestration; forcing one declaration
  // For every local in a file makes them harder to review without improving safety.
  overrides: [
    {
      files: ["scripts/**/*.ts", "scripts/**/*.mjs"],
      rules: { "one-var": "off" },
    },
    {
      files: ["scripts/**/*.ts"],
      globals: { Bun: "readonly" },
    },
  ],
});
