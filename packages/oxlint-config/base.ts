import effect from "@mpsuesser/oxlint-plugin-effect";
import { defineConfig } from "oxlint";

const effectRules: Record<string, "warn"> = Object.fromEntries(
  Object.keys(effect.configs.all.rules ?? {}).map((rule) => [rule, "warn"]),
);

// Keep the complete diagnostic surface non-blocking while the existing baseline is migrated.
const effectDiagnostics = {
  ...effect.configs.all,
  rules: effectRules,
};

export const baseConfig = defineConfig({
  extends: [effectDiagnostics],
  plugins: ["effecttsgo"],
  categories: {
    correctness: "warn",
    nursery: "warn",
    pedantic: "warn",
    perf: "warn",
    restriction: "warn",
    style: "warn",
    suspicious: "warn",
  },
  options: {
    typeAware: true,
    typeCheck: true,
  },
});
