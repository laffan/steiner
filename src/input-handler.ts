import type { DrawingState } from "./state";
import {
  cleanLineBreaks, extractDroppedText, extractTextFromDataTransfer,
  fileToDataUrl, getImageDimensions, isImageFile, isTextFile,
} from "./external-content";
import { screenToCanvas } from "./utils";

export interface InputOptions {
  onShelfDrop?: (index: number, x: number, y: number) => void;
}

export function bindInputEvents(canvas: HTMLCanvasElement, state: DrawingState, inputOpts?: InputOptions): () => void {
  const cleanups: (() => void)[] = [];

  function on<K extends keyof HTMLElementEventMap>(
    el: EventTarget, type: K, handler: (e: HTMLElementEventMap[K]) => void, listenerOpts?: AddEventListenerOptions,
  ) {
    el.addEventListener(type, handler as EventListener, listenerOpts);
    cleanups.push(() => el.removeEventListener(type, handler as EventListener, listenerOpts));
  }

  // Canvas pointer events
  on(canvas, "pointerdown", (e) => state.handlePointerDown(e));
  on(canvas, "pointermove", (e) => state.handlePointerMove(e));
  on(canvas, "pointerup", (e) => state.handlePointerUp(e));
  on(canvas, "dblclick", (e) => state.handleDoubleClick(e));
  on(canvas, "wheel", (e) => state.handleWheel(e), { passive: false });

  // Two-finger touch to pan (like Space+drag)
  let twoFingerPanning = false;
  let twoFingerStart = { x: 0, y: 0 };
  let cameraAtTwoFingerStart = { x: 0, y: 0, zoom: 1 };

  on(canvas, "touchstart", (e) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      twoFingerPanning = true;
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      twoFingerStart = { x: midX, y: midY };
      cameraAtTwoFingerStart = { ...state.camera };
    }
  }, { passive: false });

  on(canvas, "touchmove", (e) => {
    if (twoFingerPanning && e.touches.length === 2) {
      e.preventDefault();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dx = midX - twoFingerStart.x;
      const dy = midY - twoFingerStart.y;
      state.camera = {
        x: cameraAtTwoFingerStart.x + dx,
        y: cameraAtTwoFingerStart.y + dy,
        zoom: cameraAtTwoFingerStart.zoom,
      };
      state.notify("camera");
    }
  }, { passive: false });

  on(canvas, "touchend", (e) => {
    if (twoFingerPanning && e.touches.length < 2) {
      twoFingerPanning = false;
    }
  });

  // Space-to-pan state
  let spaceDown = false;
  let toolBeforeSpace: string | null = null;

  // Keyboard shortcuts
  on(window as unknown as HTMLElement, "keydown", ((e: KeyboardEvent) => {
    if (state.editingText) {
      if (e.key === "Escape") {
        state.commitText(state.editingText);
        state.editingText = null;
        state.notify("editingText");
      }
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    // Space-to-pan: hold space to temporarily pan
    if (e.key === " " && !e.repeat) {
      e.preventDefault();
      spaceDown = true;
      toolBeforeSpace = state.tool;
      state.isPanning = true;
      state.notify("tool"); // triggers cursor update
      return;
    }

    switch (e.key) {
      case "1": state.tool = "select"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); break;
      case "t": case "T": state.tool = "text"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); break;
      case "a": case "A":
        if (!e.ctrlKey && !e.metaKey) { state.tool = "drag-area"; state.brainstormMode = false; state.notify("tool"); state.notify("brainstormMode"); }
        break;
      case "b": case "B":
        if (!e.ctrlKey && !e.metaKey) {
          state.brainstormMode = !state.brainstormMode;
          if (state.brainstormMode) { state.tool = "text"; state.notify("tool"); }
          state.notify("brainstormMode");
        }
        break;
      case "Delete": case "Backspace": state.deleteSelected(); break;
      case "g": case "G":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) state.ungroupSelected();
          else state.groupSelected();
        }
        break;
      case "z": case "Z":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) state.redo();
          else state.undo();
        }
        break;
      case "y": case "Y":
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          state.redo();
        }
        break;
    }
  }) as unknown as (e: HTMLElementEventMap["keydown"]) => void);

  on(window as unknown as HTMLElement, "keyup", ((e: KeyboardEvent) => {
    if (e.key === " " && spaceDown) {
      spaceDown = false;
      state.isPanning = false;
      if (toolBeforeSpace) {
        state.tool = toolBeforeSpace as import("./types").Tool;
        toolBeforeSpace = null;
      }
      state.notify("tool");
    }
  }) as unknown as (e: HTMLElementEventMap["keyup"]) => void);

  // Paste
  on(document as unknown as HTMLElement, "paste", (async (e: ClipboardEvent) => {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
    if (state.editingText) return;
    e.preventDefault();
    const cd = e.clipboardData;
    if (!cd) return;

    for (const item of Array.from(cd.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          const dataUrl = await fileToDataUrl(file);
          const dims = await getImageDimensions(dataUrl);
          state.addImageShape(dataUrl, file.name, dims.width, dims.height);
          return;
        }
      }
    }
    const text = extractTextFromDataTransfer(cd);
    if (text && text.trim()) state.addTextShapeAtCenter(cleanLineBreaks(text));
  }) as unknown as (e: HTMLElementEventMap["paste"]) => void);

  // Drag/drop — capture phase so preventDefault() runs before the browser
  // rejects the drop target. Handles shelf items, file drops, and text drops.
  on(window as unknown as HTMLElement, "dragover", ((e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = e.dataTransfer.types.includes("application/x-shelf-index") ? "move" : "copy";
    }
  }) as unknown as (e: HTMLElementEventMap["dragover"]) => void, { capture: true });

  on(window as unknown as HTMLElement, "drop", (async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.dataTransfer) return;
    const rect = canvas.getBoundingClientRect();
    const dropPos = screenToCanvas({ x: e.clientX - rect.left, y: e.clientY - rect.top }, state.camera);

    // Shelf item drag-to-restore
    const shelfIdx = e.dataTransfer.getData("application/x-shelf-index");
    if (shelfIdx !== "") {
      inputOpts?.onShelfDrop?.(parseInt(shelfIdx, 10), dropPos.x, dropPos.y);
      return;
    }

    // File drops (images, text)
    const files = Array.from(e.dataTransfer.files);
    let handledFile = false;
    for (const file of files) {
      if (isImageFile(file)) {
        const dataUrl = await fileToDataUrl(file);
        const dims = await getImageDimensions(dataUrl);
        state.addImageShape(dataUrl, file.name, dims.width, dims.height, dropPos);
        handledFile = true;
      } else if (isTextFile(file)) {
        const text = await file.text();
        if (text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos);
        handledFile = true;
      }
    }
    if (handledFile) return;

    const text = await extractDroppedText(e.dataTransfer);
    if (text && text.trim()) state.addTextShapeAtPosition(cleanLineBreaks(text), dropPos);
  }) as unknown as (e: HTMLElementEventMap["drop"]) => void, { capture: true });

  return () => { for (const fn of cleanups) fn(); };
}
