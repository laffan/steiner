/** Cross-platform clipboard, drag/drop, and file helpers */

/** Known text MIME / pasteboard types across platforms */
export const TEXT_DATA_TYPES = [
  "text/plain",
  "text",
  "Text",
  "text/plain;charset=utf-8",
  "text/plain;charset=utf8",
  "public.utf8-plain-text",
  "public.utf16-plain-text",
  "public.text",
  "com.apple.traditional-mac-plain-text",
  "NSStringPboardType",
  "text/x-moz-text-internal",
  "text/html",
  "public.html",
  "text/uri-list",
];

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function getImageDimensions(
  dataUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}

export function extractTextFromDataTransfer(dt: DataTransfer): string {
  for (const type of TEXT_DATA_TYPES) {
    try {
      const value = dt.getData(type);
      if (value && value.trim()) return normalizeTextContent(value, type);
    } catch { /* skip */ }
  }
  return "";
}

export async function extractDroppedText(dt: DataTransfer): Promise<string> {
  const sync = extractTextFromDataTransfer(dt);
  if (sync) return sync;

  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "string") {
        const value = await new Promise<string>((resolve) => {
          try { item.getAsString((text) => resolve(text || "")); }
          catch { resolve(""); }
        });
        if (value && value.trim()) return normalizeTextContent(value, item.type);
      }
    }
  }

  const allTypes = dt.types ? Array.from(dt.types) : [];
  for (const type of allTypes) {
    try {
      const value = dt.getData(type);
      if (value && value.trim()) return normalizeTextContent(value, type);
    } catch { /* skip */ }
  }
  return "";
}

export function normalizeTextContent(value: string, type: string): string {
  const lower = (type || "").toLowerCase();
  if (lower.includes("html")) {
    try {
      const div = document.createElement("div");
      div.innerHTML = value;
      return div.textContent || div.innerText || "";
    } catch { return value; }
  }
  return value;
}

/**
 * Remove mid-sentence line breaks (single \n between non-empty lines)
 * while preserving intentional paragraph breaks (double \n or lines ending
 * with sentence-ending punctuation followed by \n).
 */
export function cleanLineBreaks(text: string): string {
  // Normalize \r\n to \n
  const s = text.replace(/\r\n/g, "\n");
  // Preserve paragraph breaks (two or more consecutive newlines)
  // Split on paragraph boundaries first, clean each paragraph, then rejoin
  const paragraphs = s.split(/\n{2,}/);
  const cleaned = paragraphs.map((para) => {
    // Within a paragraph, replace single newlines that appear mid-sentence.
    // Also handle hyphenated column breaks: "impor-\n tant" → "important"
    return para.replace(/([^\n]*)\n(?!$)/g, (match, before: string) => {
      // Keep break if line ends with sentence-ending punctuation
      if (/[.!?:]\s*$/.test(before)) return match;
      // Hyphenated word break: strip trailing hyphen and join without space
      if (/[a-zA-Z]-\s*$/.test(before)) return before.replace(/-\s*$/, "");
      // Mid-sentence break: join with space
      return before + " ";
    });
  });
  return cleaned.join("\n\n");
}

export function isImageFile(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp") || name.endsWith(".gif") || name.endsWith(".svg");
}

export function isTextFile(file: File): boolean {
  if (file.type === "text/plain") return true;
  const name = (file.name || "").toLowerCase();
  return name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".text");
}
