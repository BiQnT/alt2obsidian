// Renders a prompt template from `prompts/*.md` (single source shared by the
// plugin and the alt2obs Skill, spec 4.7).
//
// Template rules:
// - Placeholders are `{{name}}` (letters, digits, underscore).
// - Substitution is a single pass: `{{...}}` inside a substituted value is
//   left as is, and `$` in a value has no special meaning.
// - CRLF line endings are normalized to LF, so a checkout with Windows line
//   endings renders the same prompt.
// - The file's final newline is not part of the prompt, so one trailing "\n"
//   is dropped before substitution.
// - Any conditional text is computed by the caller and passed as a variable.

export type PromptVars = Record<string, string | number>;

const PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

export function renderPrompt(template: string, vars: PromptVars): string {
  const lf = template.replace(/\r\n/g, "\n");
  const body = lf.endsWith("\n") ? lf.slice(0, -1) : lf;
  const leftover = body.replace(PLACEHOLDER, "");
  if (leftover.includes("{{")) {
    throw new Error("Malformed placeholder in prompt template");
  }
  return body.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`Missing prompt variable: ${name}`);
    }
    return String(vars[name]);
  });
}
