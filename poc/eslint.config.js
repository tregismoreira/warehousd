const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

module.exports = [
  {
    ignores: ["node_modules/**", "dist/**", ".next/**"],
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
