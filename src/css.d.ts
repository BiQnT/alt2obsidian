// Ambient declaration so esbuild's text loader can `import x from "...css"`
// and TypeScript recognizes it as a string default export.
declare module "*.css" {
  const content: string;
  export default content;
}
