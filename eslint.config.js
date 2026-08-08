import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Prisma emits this from the schema; it is not ours to lint.
    ignores: ["dist/**", "src/generated/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unused args are often meaningful documentation in handler signatures;
      // allow them when explicitly marked with a leading underscore.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Fastify hooks and signal handlers take void-returning callbacks that
      // we deliberately hand async functions; the rule's default flags every
      // one of them.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],

      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // A Fastify plugin signals it has finished registering by returning a
      // promise, so plugins must be declared async whether or not they happen
      // to await anything. The rule flags every one of them, and the fix it
      // wants — dropping `async` — would make Fastify hang waiting for a
      // `done` callback that isn't there.
      "@typescript-eslint/require-await": "off",
    },
  },
  prettier,
);
