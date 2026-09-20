import { baseConfig } from "./packages/oxlint-config/base.ts";
import { defineConfig } from "oxlint";

export default defineConfig({
  env: { builtin: true, node: true },
  extends: [baseConfig],
});
