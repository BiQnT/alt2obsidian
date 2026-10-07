/**
 * A value from parsed JSON as text: a string as it is, a number or boolean
 * written out, an array joined with "," (as String() does), anything else
 * (null, an object) empty.
 */
export function jsonValueText(v: unknown): string {
  if (Array.isArray(v)) return v.map(jsonValueText).join(",");
  return typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
}

export function slugify(text: string): string {
  return text
    .trim()
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text without control characters (U+0000 to U+001F), which a file name cannot hold. */
export function withoutControlChars(text: string): string {
  let out = "";
  for (const ch of text) if (ch.charCodeAt(0) > 0x1f) out += ch;
  return out;
}

export function sanitizeFilename(name: string): string {
  return withoutControlChars(name)
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\.+$/, "")
    .trim();
}

export function formatDate(date?: Date): string {
  const d = date || new Date();
  return d.toISOString().slice(0, 10);
}

export function isAltUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "altalt.io" ||
      parsed.hostname === "www.altalt.io"
    );
  } catch {
    return false;
  }
}

export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
