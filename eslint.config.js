import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "coverage/",
      "dist/",
      ".assetforge/",
      // Vendored from Clockgrove as they are (test/fixtures/clockgrove/README.md).
      "test/fixtures/clockgrove/{model-asset,validation,model}.ts",
      "test/fixtures/clockgrove/inspect-model.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
