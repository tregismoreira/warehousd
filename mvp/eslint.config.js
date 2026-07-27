const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

module.exports = [
  {
    // Patterns must be `**/`-prefixed: a bare `dist/**` only matches the repo
    // root, leaving built artifacts like packages/cli/dist/index.cjs to be
    // linted (and fail) as soon as anyone runs a build before `pnpm lint`.
    ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["packages/broker/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@anthropic-ai/*", "next", "next/*", "@modelcontextprotocol/*", "react", "react-dom"],
            message: "packages/broker must stay free of HTTP/MCP/UI/LLM deps (SPEC §5.1, §14)." }
        ]
      }]
    }
  }
];
