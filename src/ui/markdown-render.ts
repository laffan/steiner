/**
 * Minimal markdown → DOM renderer for chat bubbles in the chat-history panel.
 *
 * Scope: what Claude actually emits in the Ask Claude flow — paragraphs,
 * headings, ordered/unordered lists, bold, italic, inline code, fenced code
 * blocks, and links. Anything else falls back to plain text so the bubble
 * never renders worse than the previous `.textContent` path.
 *
 * No third-party dependency: a markdown library would dwarf the rest of the
 * web bundle. The set of constructs here is small and well-defined.
 */

export function renderMarkdownToFragment(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const blocks = splitBlocks(source.replace(/\r\n/g, "\n"));
  for (const block of blocks) {
    const el = renderBlock(block);
    if (el) frag.appendChild(el);
  }
  return frag;
}

interface Block {
  kind: "paragraph" | "heading" | "ul" | "ol" | "code";
  lines: string[];
  /** Heading level (1–6) — only set when kind === "heading". */
  level?: number;
  /** Code block language hint — only set when kind === "code". */
  lang?: string;
}

function splitBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines between blocks.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ``` … ```
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      // Skip the closing fence (if any).
      if (i < lines.length) i++;
      blocks.push({ kind: "code", lines: buf, lang });
      continue;
    }

    // ATX heading (# … ######).
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        lines: [heading[2]],
      });
      i++;
      continue;
    }

    // Unordered list: consecutive `-` / `*` / `+` items.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", lines: items });
      continue;
    }

    // Ordered list: consecutive `\d+.` items.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", lines: items });
      continue;
    }

    // Paragraph: collect until blank line or block-starter.
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === "") break;
      if (/^```/.test(cur)) break;
      if (/^#{1,6}\s+/.test(cur)) break;
      if (/^\s*[-*+]\s+/.test(cur)) break;
      if (/^\s*\d+\.\s+/.test(cur)) break;
      para.push(cur);
      i++;
    }
    blocks.push({ kind: "paragraph", lines: para });
  }
  return blocks;
}

function renderBlock(block: Block): HTMLElement | null {
  switch (block.kind) {
    case "paragraph": {
      const p = document.createElement("p");
      p.style.margin = "0 0 8px 0";
      // Single newlines inside a paragraph become <br> — Claude often wraps
      // longer paragraphs across lines and we want them visually one block.
      const joined = block.lines.join("\n");
      appendInline(p, joined);
      return p;
    }
    case "heading": {
      const tag = `h${Math.min(Math.max(block.level || 1, 1), 6)}` as keyof HTMLElementTagNameMap;
      const el = document.createElement(tag) as HTMLElement;
      el.style.margin = "8px 0 4px 0";
      el.style.fontWeight = "600";
      // Scale down inside chat bubbles — the panel font size is 13px.
      const scale = block.level === 1 ? 1.35 : block.level === 2 ? 1.2 : 1.08;
      el.style.fontSize = `${(scale * 100).toFixed(0)}%`;
      appendInline(el, block.lines[0] || "");
      return el;
    }
    case "ul":
    case "ol": {
      const list = document.createElement(block.kind);
      list.style.margin = "0 0 8px 0";
      list.style.paddingLeft = "20px";
      for (const item of block.lines) {
        const li = document.createElement("li");
        li.style.marginBottom = "2px";
        appendInline(li, item);
        list.appendChild(li);
      }
      return list;
    }
    case "code": {
      const pre = document.createElement("pre");
      pre.style.margin = "0 0 8px 0";
      pre.style.padding = "8px 10px";
      pre.style.background = "#f4f4f4";
      pre.style.borderRadius = "6px";
      pre.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
      pre.style.fontSize = "12px";
      pre.style.overflowX = "auto";
      pre.style.whiteSpace = "pre";
      const code = document.createElement("code");
      if (block.lang) code.className = `language-${block.lang}`;
      code.textContent = block.lines.join("\n");
      pre.appendChild(code);
      return pre;
    }
  }
}

// Inline tokens: **bold**, *italic*, _italic_, `code`, [text](url),
// ==highlight==. The pattern is run repeatedly via String.prototype.split
// so we don't have to track positions manually.
const INLINE_PATTERN =
  /(\*\*[^*]+?\*\*|\*[^*\n]+?\*|_[^_\n]+?_|`[^`\n]+?`|\[[^\]\n]+?\]\([^)\n]+?\)|==[^=\n]+?==)/g;

function appendInline(parent: HTMLElement, text: string): void {
  let last = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > last) appendTextWithBreaks(parent, text.slice(last, idx));
    parent.appendChild(renderInlineToken(match[0]));
    last = idx + match[0].length;
  }
  if (last < text.length) appendTextWithBreaks(parent, text.slice(last));
}

function appendTextWithBreaks(parent: HTMLElement, text: string): void {
  // Preserve hard line breaks within a paragraph as <br>.
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) parent.appendChild(document.createElement("br"));
    if (parts[i]) parent.appendChild(document.createTextNode(parts[i]));
  }
}

function renderInlineToken(token: string): Node {
  if (token.startsWith("**") && token.endsWith("**")) {
    const el = document.createElement("strong");
    appendInline(el, token.slice(2, -2));
    return el;
  }
  if ((token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))) {
    const el = document.createElement("em");
    appendInline(el, token.slice(1, -1));
    return el;
  }
  if (token.startsWith("`") && token.endsWith("`")) {
    const el = document.createElement("code");
    el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";
    el.style.fontSize = "92%";
    el.style.background = "#eee";
    el.style.padding = "1px 4px";
    el.style.borderRadius = "3px";
    el.textContent = token.slice(1, -1);
    return el;
  }
  if (token.startsWith("==") && token.endsWith("==")) {
    const el = document.createElement("mark");
    el.style.background = "#fff4c4";
    el.style.padding = "0 2px";
    appendInline(el, token.slice(2, -2));
    return el;
  }
  // Link: [text](url)
  const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) {
    const a = document.createElement("a");
    a.href = link[2];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.color = "#1a3d80";
    appendInline(a, link[1]);
    return a;
  }
  // Fallback — shouldn't hit this since the regex matched.
  return document.createTextNode(token);
}
