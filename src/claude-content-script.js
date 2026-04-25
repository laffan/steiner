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

  window.__steinerCapturePin = function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      flashToast("No text selected — highlight text first, then press ⌘⇧P");
      return;
    }
    var text = sel.toString().trim();
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
