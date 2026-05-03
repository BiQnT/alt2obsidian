// Slide content hashing for hash-augmented index markers (plan §B Decision B).
//
// Algorithm validated by .omc/research/spike-1.0b-hash-algo.md and
// .omc/research/spike-1.0b-validator.mjs (10/10 hostile cases pass).
//
// Hash function: SHA-1 of rendered slide PNG bytes, truncated to first 8 hex
// chars (32 bits). Collision probability for a 200-slide deck is ~1 in 216k
// (birthday-bounded), and the dup:N suffix mechanism handles the rare collision
// case deterministically — see spike doc §6.

/**
 * SHA-1 over arbitrary bytes (Uint8Array | ArrayBuffer | Buffer-shaped input),
 * returned as the first 8 hex characters.
 *
 * Uses Web Crypto API which is available in Obsidian's Electron renderer and in
 * modern Node (via globalThis.crypto). No external dependency.
 */
export async function sha1Hex8(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  // crypto.subtle.digest accepts BufferSource (= ArrayBufferView | ArrayBuffer).
  // Normalizing to a fresh Uint8Array sidesteps the TS-5.6+ ArrayBufferLike
  // discrimination (Uint8Array.buffer can be SharedArrayBuffer in newer typing).
  const view = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-1", view);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 8);
}

/**
 * Convenience wrapper that takes a base64-encoded PNG (the format produced by
 * `PdfProcessor.renderPagesToImages` and `cropPageRegion`) and returns the
 * 8-hex slide hash.
 */
export async function hashSlidePngBase64(base64Png: string): Promise<string> {
  const binary = atob(base64Png);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return sha1Hex8(bytes);
}
