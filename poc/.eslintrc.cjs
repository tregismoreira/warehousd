module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended"],
  overrides: [
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
  ]
};
