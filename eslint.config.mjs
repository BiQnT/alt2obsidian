// ESLint with the official Obsidian rules (eslint-plugin-obsidianmd, the
// rules the community directory's automated review runs): `npm run lint`.
// Linted: the plugin source (src/), package.json and manifest.json. Not
// linted, as in the directory's scanner: tests, the Skill and build scripts
// (scripts/), docs, prompts, *.mjs build files and the build output.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["main.js", "node_modules", "test/**", "scripts/**", "docs/**", "prompts/**", "**/*.mjs", "**/*.cjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
    rules: {
      // Proper nouns in the (mostly Korean) UI text keep their casing: the
      // Alt app, this plugin under its new and old name, Claude Code, Codex,
      // and the folder names the plugin writes to (Attachments/ and so on).
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          brands: [...DEFAULT_BRANDS, "Alt", "Alt2Obs", "Alt2Obsidian", "Claude Code", "Codex", "Attachments", "Lectures", "Concepts", "Verification"],
          acronyms: [...DEFAULT_ACRONYMS, "MCP"],
        },
      ],
    },
  },
  {
    // The manifest, checked with the directory's rules (name, id and
    // description wording, no fundingUrl without donations, types).
    files: ["manifest.json"],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false, extraFileExtensions: [".json"] } },
    rules: { "obsidianmd/validate-manifest": "error" },
  },
]);
