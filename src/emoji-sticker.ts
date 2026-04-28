/**
 * Detect whether a string consists entirely of emoji characters (with
 * optional whitespace between them) and rasterize emoji to a PNG so the
 * canvas can show them as image "stickers" that scale and crop the same
 * way as any other image shape.
 */

// Allowed inside an emoji cluster: extended pictographics (the emoji
// codepoints themselves), emoji modifiers (skin tones), variation selector
// 16 (forces emoji presentation), zero-width joiner (combines pictographs
// into family/profession sequences), regional indicators (flags), and the
// keycap combining mark.
const EMOJI_CLUSTER_RE = new RegExp(
  "^(?:" +
    "\\p{Extended_Pictographic}" +
    "(?:\\p{Emoji_Modifier}|\\uFE0F|\\u200D\\p{Extended_Pictographic})*" +
    "|\\p{Regional_Indicator}\\p{Regional_Indicator}" +
    "|[0-9#*]\\uFE0F\\u20E3" +
    ")$",
  "u",
);

/** True iff `text` is one or more emoji clusters separated by whitespace. */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Split into grapheme clusters via Intl.Segmenter when available (handles
  // ZWJ sequences correctly); fall back to naive split for environments
  // without it (older WebViews).
  const SegmenterCtor = (Intl as unknown as {
    Segmenter?: new (locale: string, opts: { granularity: string }) => {
      segment(s: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;

  const clusters: string[] = [];
  if (SegmenterCtor) {
    const seg = new SegmenterCtor("en", { granularity: "grapheme" }).segment(trimmed);
    for (const s of seg) {
      const piece = s.segment;
      if (/^\s+$/.test(piece)) continue;
      clusters.push(piece);
    }
  } else {
    for (const piece of trimmed.split(/\s+/)) {
      if (piece) clusters.push(piece);
    }
  }
  if (clusters.length === 0) return false;
  return clusters.every((c) => EMOJI_CLUSTER_RE.test(c));
}

/**
 * Rasterize an emoji string to a square PNG data URL. The canvas is sized
 * for the device pixel ratio so the sticker stays crisp on hi-DPI screens.
 */
export function emojiToDataUrl(emoji: string, sizePx: number): string {
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(sizePx * dpr);
  canvas.height = Math.round(sizePx * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // No 2d context — return a 1×1 transparent png as a graceful fallback.
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  }
  ctx.scale(dpr, dpr);
  // 0.85 leaves a small inset so accents/jutting glyphs don't get clipped.
  const fontPx = Math.round(sizePx * 0.85);
  ctx.font =
    `${fontPx}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji",` +
    " -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, sizePx / 2, sizePx / 2);
  return canvas.toDataURL("image/png");
}
