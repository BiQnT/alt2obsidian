// Ambient declaration so esbuild's text loader can `import x from "...md"`
// (prompt templates in `prompts/`) and TypeScript sees a string default export.
declare module "*.md" {
  const content: string;
  export default content;
}
