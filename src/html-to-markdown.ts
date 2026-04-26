// HTML → Markdown converter — handles the formatting the canvas's markdown
// renderer cares about (headings, bold, italic, links) plus a few helpers
// (lists, code, blockquote, br) that degrade gracefully.
//
// Mirrored intentionally in src/claude-content-script.js: the content script
// runs inside the claude.ai webview where it can't import from this module.

export function htmlToMarkdown(root: Element): string {
  function walk(node: Node): string {
    if (node.nodeType === 3) {
      return (node.textContent || "").replace(/\s+/g, " ");
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    let inner = "";
    for (let i = 0; i < el.childNodes.length; i++) {
      inner += walk(el.childNodes[i]);
    }
    switch (tag) {
      case "h1": return "\n\n# " + inner.trim() + "\n\n";
      case "h2": return "\n\n## " + inner.trim() + "\n\n";
      case "h3": return "\n\n### " + inner.trim() + "\n\n";
      case "h4":
      case "h5":
      case "h6": return "\n\n#### " + inner.trim() + "\n\n";
      case "strong":
      case "b": return inner.trim() ? "**" + inner.trim() + "**" : "";
      case "em":
      case "i": return inner.trim() ? "*" + inner.trim() + "*" : "";
      case "a": {
        const href = el.getAttribute("href") || "";
        const label = inner.trim() || href;
        if (!href) return label;
        return `[${label}](${href})`;
      }
      case "code": {
        const parent = el.parentElement;
        if (parent && parent.tagName.toLowerCase() === "pre") return inner;
        return "`" + inner + "`";
      }
      case "pre": return "\n\n```\n" + inner.replace(/\n+$/, "") + "\n```\n\n";
      case "br": return "\n";
      case "hr": return "\n\n---\n\n";
      case "p":
      case "div": return inner + "\n\n";
      case "ul":
      case "ol": return "\n" + inner + "\n";
      case "li": {
        const p = el.parentElement;
        let marker = "- ";
        if (p && p.tagName.toLowerCase() === "ol") {
          const idx = Array.prototype.indexOf.call(p.children, el) + 1;
          marker = `${idx}. `;
        }
        return marker + inner.trim() + "\n";
      }
      case "blockquote":
        return inner
          .trim()
          .split("\n")
          .map((l) => "> " + l)
          .join("\n") + "\n\n";
      default:
        return inner;
    }
  }
  let out = "";
  for (let i = 0; i < root.childNodes.length; i++) {
    out += walk(root.childNodes[i]);
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Convenience: parse an HTML string into a wrapper element and convert it. */
export function htmlStringToMarkdown(html: string): string {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  return htmlToMarkdown(wrap);
}
