// ESLint with the official Obsidian rules (eslint-plugin-obsidianmd, the
// rules the community directory's automated review runs): `npm run lint`.
// Linted: the plugin source (src/), package.json and manifest.json. Not
// linted, as in the directory's scanner: tests, the Skill and build scripts
// (scripts/), docs, prompts, *.mjs build files and the build output.
// `npm run lint` then runs `npm run lint:directory`: these rules over src/
// with type information built as the directory's TypeScript 6 builds it
// (eslint.directory.config.mjs).
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import tseslint from "typescript-eslint";

// The manifest rule, except its "no 'obsidian' in the id" report for this
// plugin's id: the directory keeps the id `alt2obsidian` it already lists
// (a directory admin confirmed it on 2026-10-07, spec D13). Every other
// manifest check, the name and description included, still runs.
const validateManifest = obsidianmd.rules["validate-manifest"];
const manifestRule = {
  ...validateManifest,
  create(context) {
    const report = (problem) => {
      if (problem.messageId === "noForbiddenWords" && problem.data?.key === "id" && problem.node?.value === "alt2obsidian") return;
      context.report(problem);
    };
    return validateManifest.create(Object.create(context, { report: { value: report } }));
  },
};

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
    // getSettingDefinitions() is an Obsidian 1.13 API: the typings this
    // plugin builds against (obsidian 1.12.3) do not have it, and below 1.13
    // (minAppVersion is 1.7.2) the tab needs display(), as the
    // settings-tab/require-display rule says. On 1.13 a non-empty list
    // replaces display() altogether (the tab is drawn from the definitions),
    // so settings search would mean rewriting this custom tab declaratively.
    // The directory's scan still reports it.
    files: ["src/ui/SettingsTab.ts"],
    rules: { "obsidianmd/settings-tab/prefer-setting-definitions": "off" },
  },
  {
    // The manifest, checked with the directory's rules (name, id and
    // description wording, no fundingUrl without donations, types), with the
    // kept id allowed (manifestRule above).
    files: ["manifest.json"],
    languageOptions: { parser: tseslint.parser, parserOptions: { projectService: false, extraFileExtensions: [".json"] } },
    plugins: { local: { rules: { "validate-manifest": manifestRule } } },
    rules: { "obsidianmd/validate-manifest": "off", "local/validate-manifest": "error" },
  },
]);
