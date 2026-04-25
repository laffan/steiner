export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts?: {
    cls?: string;
    attrs?: Record<string, string>;
    style?: Partial<CSSStyleDeclaration>;
    text?: string;
    title?: string;
    html?: string;
    children?: (HTMLElement | string)[];
    onClick?: (e: MouseEvent) => void;
  },
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (opts?.cls) el.className = opts.cls;
  if (opts?.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  if (opts?.style) Object.assign(el.style, opts.style);
  if (opts?.text) el.textContent = opts.text;
  if (opts?.title) el.title = opts.title;
  if (opts?.html) el.innerHTML = opts.html;
  if (opts?.onClick) el.addEventListener("click", opts.onClick as EventListener);
  if (opts?.children) {
    for (const child of opts.children) {
      if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else el.appendChild(child);
    }
  }
  return el;
}

export function setStyles(el: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(el.style, styles);
}

export function clearChildren(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
