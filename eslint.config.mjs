import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * The one structural rule of this repository: the matching engine, the price
 * sources, the bots, the public data stores and the config schema are plain
 * TypeScript. None of them may import Fastify or any HTTP framework, so none
 * of their tests need a running server.
 */
const domainStaysFrameworkFree = {
  files: [
    "src/engine/**/*.ts",
    "src/prices/**/*.ts",
    "src/bots/**/*.ts",
    "src/data/**/*.ts",
    "src/config/**/*.ts",
    "src/rollup/**/*.ts",
  ],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["fastify", "@fastify/*"],
            message: "This folder is framework-free. Put this in src/http instead.",
          },
        ],
      },
    ],
  },
};

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  domainStaysFrameworkFree,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["scripts/**", "src/main.ts", "src/app.ts"],
    rules: { "no-console": "off" },
  },
  globalIgnores(["docker/**", "dist/**", "coverage/**", "data/**", "node_modules/**"]),
]);
