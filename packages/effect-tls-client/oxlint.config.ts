import { baseConfig } from "@effect-tls-client/oxlint-config/base";
import { defineConfig } from "oxlint";

export default defineConfig({
  env: { builtin: true, node: true },
  extends: [baseConfig],
  globals: { Bun: "readonly" },
});
