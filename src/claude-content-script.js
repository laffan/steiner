// Steiner content script — injected into the embedded claude.ai webview.
// Runs once per page-load (initialization_script). Handles two flows:
//
//   1) Pin: when window.__steinerCapturePin() is called (triggered by the
//      Cmd+Shift+P global shortcut from Rust), capture the current selection
//      with metadata and invoke the `pin_snippet` Tauri command.
//
//   2) Send-to-Claude: window.__steinerSendToClaude({text, submit}) finds
//      the prompt input, injects text, and (optionally) submits.
//
// The invoke channel uses window.__TAURI_INTERNALS__.invoke, exposed by the
// Tauri runtime when the webview's capability grants remote access.
(function () {
  if (window.__steinerInjected) return;
  window.__steinerInjected = true;

  function invoke(cmd, args) {
    var internals =
      window.__TAURI_INTERNALS__ ||
      (window.__TAURI__ && window.__TAURI__.core);
    if (internals && typeof internals.invoke === "function") {
      return internals.invoke(cmd, args);
    }
    return Promise.reject(new Error("Tauri IPC not available in this webview"));
  }

  function nearestBlockText(node) {
    if (!node) return "";
    var el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      var d = window.getComputedStyle(el).display;
      if (
        d === "block" ||
        d === "list-item" ||
        d === "flex" ||
        d === "grid" ||
        el.tagName === "P" ||
        el.tagName === "LI" ||
        el.tagName === "ARTICLE" ||
        el.tagName === "SECTION"
      ) {
        return (el.innerText || el.textContent || "").trim();
      }
      el = el.parentElement;
    }
    return "";
  }

  function genId() {
    return (
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
    );
  }

  // Convert a DOM node's children to markdown. Handles the formatting the
  // canvas renderer understands (headings, bold, italic, links) plus a few
  // helpers (lists, code, blockquote, line breaks) that degrade gracefully.
  function htmlToMarkdown(root) {
    function walk(node, ctx) {
      if (node.nodeType === 3) {
        // Collapse runs of whitespace inside text nodes — preserves spacing
        // without dragging in all of claude.ai's pretty-printed indentation.
        return (node.textContent || "").replace(/\s+/g, " ");
      }
      if (node.nodeType !== 1) return "";
      var tag = node.tagName.toLowerCase();
      var inner = "";
      for (var i = 0; i < node.childNodes.length; i++) {
        inner += walk(node.childNodes[i], ctx);
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
          var href = node.getAttribute("href") || "";
          var label = inner.trim() || href;
          if (!href) return label;
          return "[" + label + "](" + href + ")";
        }
        case "code": {
          var parent = node.parentElement;
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
          var p = node.parentElement;
          var marker = "- ";
          if (p && p.tagName.toLowerCase() === "ol") {
            var idx =
              Array.prototype.indexOf.call(p.children, node) + 1;
            marker = idx + ". ";
          }
          return marker + inner.trim() + "\n";
        }
        case "blockquote":
          return (
            inner
              .trim()
              .split("\n")
              .map(function (l) {
                return "> " + l;
              })
              .join("\n") + "\n\n"
          );
        default: return inner;
      }
    }
    var out = "";
    for (var i = 0; i < root.childNodes.length; i++) {
      out += walk(root.childNodes[i], {});
    }
    // Tidy: collapse 3+ newlines to 2, trim ends.
    return out.replace(/\n{3,}/g, "\n\n").trim();
  }

  function selectionToMarkdown(sel) {
    try {
      var range = sel.getRangeAt(0);
      var frag = range.cloneContents();
      var wrap = document.createElement("div");
      wrap.appendChild(frag);
      var md = htmlToMarkdown(wrap);
      return md || sel.toString().trim();
    } catch (e) {
      return sel.toString().trim();
    }
  }

  window.__steinerCapturePin = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      flashToast("No text selected — highlight text first, then press ⌘⇧P");
      return;
    }
    var text = selectionToMarkdown(sel);
    if (!text) {
      flashToast("Selection is empty");
      return;
    }
    var anchor = sel.anchorNode;
    var blockText = nearestBlockText(anchor);
    var context = blockText.slice(0, 200);
    var snippet = {
      id: genId(),
      text: text,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      context: context,
    };
    invoke("pin_snippet", { snippet: snippet })
      .then(function () {
        flashToast("Pinned — click on canvas to place");
      })
      .catch(function (err) {
        console.warn("[steiner] pin_snippet failed:", err);
        flashToast("Pin failed: " + (err && err.message ? err.message : err));
      });
  };

  // Persist the current chat URL so we restore it on next launch.
  // claude.ai is a SPA — pushState/replaceState don't fire navigation events
  // on the WebView, so we wrap them and listen for popstate too.
  function reportUrl() {
    invoke("set_last_url", { url: window.location.href }).catch(function () {});
  }
  reportUrl();
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () {
      var ret = orig.apply(this, arguments);
      reportUrl();
      return ret;
    };
  });
  window.addEventListener("popstate", reportUrl);
  window.addEventListener("hashchange", reportUrl);

  // Resilient query for the prompt input. Tries contenteditable first
  // (current claude.ai), then textarea, then any input-like role.
  function findPromptInput() {
    var candidates = [
      'div[contenteditable="true"][role="textbox"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
      "textarea",
    ];
    for (var i = 0; i < candidates.length; i++) {
      var nodes = document.querySelectorAll(candidates[i]);
      // Prefer the largest visible candidate (the main prompt area).
      var best = null;
      var bestArea = 0;
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        var rect = n.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        var area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = n;
        }
      }
      if (best) return best;
    }
    return null;
  }

  function findSubmitButton(input) {
    // Walk up the DOM looking for a sibling/parent button with a submit-y
    // shape. Falls back to any button that looks like a send action.
    var ancestor = input ? input.parentElement : document.body;
    for (var i = 0; i < 6 && ancestor; i++) {
      var btn =
        ancestor.querySelector(
          'button[type="submit"], button[aria-label*="Send" i], button[aria-label*="submit" i]',
        );
      if (btn) return btn;
      ancestor = ancestor.parentElement;
    }
    return document.querySelector(
      'button[aria-label*="Send" i], button[type="submit"]',
    );
  }

  function setProseMirrorText(el, text) {
    el.focus();
    // Replace existing content
    var sel = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false);
    // Insert text — execCommand insertText fires the input events the
    // editor framework needs to register the change.
    var ok = document.execCommand("insertText", false, text);
    if (!ok) {
      // Fallback: dispatch a beforeinput/input event sequence.
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
  }

  function setTextareaText(el, text) {
    var setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    );
    if (setter && setter.set) {
      setter.set.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  window.__steinerSendToClaude = function (payload) {
    try {
      var text = (payload && payload.text) || "";
      var submit = !!(payload && payload.submit);
      var input = findPromptInput();
      if (!input) {
        copyToClipboard(text);
        flashToast("Couldn't find prompt input — copied to clipboard");
        return false;
      }
      input.focus();
      if (input.tagName === "TEXTAREA") {
        setTextareaText(input, text);
      } else {
        setProseMirrorText(input, text);
      }
      flashToast("Inserted into Claude");
      if (submit) {
        // Give the framework a tick to register the value
        setTimeout(function () {
          var btn = findSubmitButton(input);
          if (btn && !btn.disabled) {
            btn.click();
          } else {
            // Fall back to Enter key
            input.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                bubbles: true,
              }),
            );
          }
        }, 80);
      }
      return true;
    } catch (e) {
      console.warn("[steiner] send_to_claude failed:", e);
      copyToClipboard((payload && payload.text) || "");
      flashToast("Insert failed — copied to clipboard");
      return false;
    }
  };

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
      return;
    }
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
  }

  function flashToast(msg) {
    var existing = document.getElementById("__steiner_toast");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.id = "__steiner_toast";
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "10px 16px",
      background: "rgba(20,20,20,0.92)",
      color: "#fff",
      fontSize: "13px",
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      borderRadius: "8px",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
    });
    document.body.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2000);
  }

  // Also catch the shortcut locally — some platforms only deliver global
  // shortcuts to the focused webview, others not at all when the webview
  // has focus. Belt-and-suspenders.
  window.addEventListener(
    "keydown",
    function (e) {
      var meta = e.metaKey || e.ctrlKey;
      if (meta && e.shiftKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        e.stopPropagation();
        window.__steinerCapturePin();
      }
    },
    true,
  );
})();
