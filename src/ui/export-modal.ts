// In-page export modal. iOS WKWebView blocks window.open(), so the popup
// approach we used on desktop doesn't work there. Instead, show a fullscreen
// overlay in the running window and trigger window.print() against a media
// stylesheet that hides everything except the export image. The print dialog
// then renders just the image, and the user can save to Files / print as PDF.

import { h } from "./dom-helpers";

const ROOT_CLASS = "steiner-export-modal";
const IMAGE_CLASS = "steiner-export-image";
const STYLE_ID = "__steiner_export_print_style";

function ensurePrintStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // The print rules:
  //   - Hide every direct body child except the export modal.
  //   - Reset the modal to a flat container so the image takes the page.
  //   - Hide the modal's chrome (header, buttons), keep only the image.
  style.textContent = `
@media print {
  body > *:not(.${ROOT_CLASS}) { display: none !important; }
  .${ROOT_CLASS} {
    position: static !important;
    inset: auto !important;
    background: #fff !important;
    padding: 0 !important;
    margin: 0 !important;
    width: 100% !important;
    height: auto !important;
    overflow: visible !important;
    display: block !important;
  }
  .${ROOT_CLASS} > *:not(.${IMAGE_CLASS}) { display: none !important; }
  .${IMAGE_CLASS} {
    max-width: 100% !important;
    max-height: none !important;
    width: 100% !important;
    height: auto !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    page-break-inside: avoid;
  }
  @page { size: landscape; margin: 0.5in; }
}
`;
  document.head.appendChild(style);
}

interface OpenArgs {
  title: string;
  dataUrl: string;
}

export function showExportModal(args: OpenArgs) {
  ensurePrintStyle();

  const titleEl = h("div", {
    style: {
      flex: "1",
      fontSize: "13px",
      fontWeight: "600",
      color: "#fff",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    children: [args.title || "Export"],
  });

  const printBtn = h("button", {
    style: {
      padding: "8px 14px",
      border: "none",
      background: "#fff",
      color: "#0f0f0f",
      borderRadius: "8px",
      fontSize: "13px",
      fontWeight: "600",
      cursor: "pointer",
      fontFamily: "inherit",
    },
    children: ["Print / Save as PDF"],
  });

  const closeBtn = h("button", {
    style: {
      padding: "8px 14px",
      border: "1px solid rgba(255,255,255,0.3)",
      background: "transparent",
      color: "#fff",
      borderRadius: "8px",
      fontSize: "13px",
      cursor: "pointer",
      fontFamily: "inherit",
    },
    children: ["Close"],
  });

  const header = h("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: "12px",
      padding: "12px 16px",
      background: "rgba(0,0,0,0.55)",
      backdropFilter: "blur(6px)",
      flex: "0 0 auto",
    },
    children: [titleEl, printBtn, closeBtn],
  });

  const img = h("img", {
    attrs: { src: args.dataUrl, alt: args.title || "Export" },
    style: {
      maxWidth: "94%",
      maxHeight: "100%",
      objectFit: "contain",
      background: "#fff",
      borderRadius: "8px",
      boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
    },
  });
  img.classList.add(IMAGE_CLASS);

  const stage = h("div", {
    style: {
      flex: "1",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      overflow: "auto",
    },
    children: [img],
  });

  const overlay = h("div", {
    style: {
      position: "fixed",
      inset: "0",
      background: "rgba(15,15,15,0.92)",
      zIndex: "10000",
      display: "flex",
      flexDirection: "column",
    },
    children: [header, stage],
  });
  overlay.classList.add(ROOT_CLASS);

  function close() {
    overlay.remove();
  }

  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    // Click on the dimmed backdrop (outside the image and chrome) closes.
    if (e.target === overlay || e.target === stage) close();
  });
  printBtn.addEventListener("click", () => {
    // Defer one tick so the print dialog opens *after* the click handler
    // settles — some platforms cancel print() if it fires synchronously
    // inside a button click while focus is still resolving.
    setTimeout(() => window.print(), 0);
  });

  document.body.appendChild(overlay);
}
