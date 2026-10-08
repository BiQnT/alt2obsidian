// The community directory's source scan, run locally: `npm run lint:directory`
// (also part of `npm run lint`, so CI runs it). The rules of eslint.config.mjs
// (the obsidianmd recommended set, which brings typescript-eslint's
// type-checked rules, no-unsafe-* among them) over src/, with the type
// information built the way the scanner's TypeScript 6 builds it: `types` is
// [] unless tsconfig.json lists packages, so no @types package is loaded on
// its own. Under TypeScript 5 every installed @types package is loaded, so
// Node's APIs typed fine here while the scanner saw them as error types
// (643 no-unsafe-* reports on 2.0.1); tsconfig.json now names "node".
import { fileURLToPath } from "node:url";
import ts from "typescript";
import base from "./eslint.config.mjs";

const tsconfig = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL("./tsconfig.json", import.meta.url)), undefined, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  },
});
const program = ts.createProgram(tsconfig.fileNames, { types: [], ...tsconfig.options });

export default [
  ...base,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: false, programs: [program] } },
  },
];
