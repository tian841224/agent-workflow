import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Scoped to src/ only: tsc --noEmit already owns type correctness, so this gate exists for the
// quality rules a type-checker does not see (unused bindings, unreachable code, accidental globals).
export default tseslint.config({
  files: ["src/**/*.ts"],
  extends: [js.configs.recommended, ...tseslint.configs.recommended]
});
