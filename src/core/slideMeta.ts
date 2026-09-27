// Per-slide metadata kept inside the managed block (spec 5.4):
//
//   <!-- alt2obs:meta img:<128 hex> gist:"<JSON string>" -->
//
// The slide marker grammar (`<!-- alt2obs:slide:N hash:H start|end -->`,
// parsed by src/core/merge.ts) is unchanged: this is a separate comment on
// the last line of the managed body (after a blank line), so 1.x parsers treat it as commentary
// and it is replaced with the block on every re-import. It lets a re-import
// skip a slide whose text hash AND render signal are unchanged, and reuse
// its gist for the overview and concept steps without an LLM call.

const META_RE = /\n*<!-- alt2obs:meta img:([0-9a-f]{128}|[0-9a-f]{64}|none) gist:("(?:[^"\\]|\\.)*") -->\s*$/;

/** JSON string with no "--" or ">" so it can sit inside an HTML comment. */
function commentSafeJson(value: string): string {
  return JSON.stringify(value).replace(/-/g, "\\u002d").replace(/>/g, "\\u003e");
}

export function formatSlideMeta(imageSignal: string | null, gist: string): string {
  return `<!-- alt2obs:meta img:${imageSignal ?? "none"} gist:${commentSafeJson(gist)} -->`;
}

export interface SlideMeta {
  imageSignal: string | null;
  gist: string;
}

/** Metadata at the end of a managed body, or null (1.x notes, Skill notes). */
export function parseSlideMeta(managed: string): SlideMeta | null {
  const m = managed.match(META_RE);
  if (!m) return null;
  try {
    return { imageSignal: m[1] === "none" ? null : m[1], gist: JSON.parse(m[2]) };
  } catch {
    return null;
  }
}

/** Managed body without its metadata line. */
export function stripSlideMeta(managed: string): string {
  return managed.replace(META_RE, "");
}
