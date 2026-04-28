import type { Shape } from "./types";
import type { FlowEdge } from "./flowchart";

const MAX_HISTORY = 100;

/** A single point in canvas history. The renderer state (camera, hover,
 *  editing) is intentionally NOT captured — it's view, not document. */
export interface HistorySnapshot {
  shapes: Shape[];
  flowEdges: FlowEdge[];
  selectedIds: string[];
}

/**
 * Snapshot-based undo/redo manager.
 *
 * History is an array of checkpoints (shapes + flowchart edges +
 * selection). The index points to the "current" checkpoint. record()
 * appends a new checkpoint after the current index (discarding any redo
 * entries). undo()/redo() move the index and return the snapshot to
 * restore.
 */
export class UndoManager {
  private _history: HistorySnapshot[] = [];
  private _index = -1;

  /** Capture the initial state. Call once on startup / after loading shapes. */
  init(snap: HistorySnapshot) {
    this._history = [clone(snap)];
    this._index = 0;
  }

  /** Record a new checkpoint after a completed action. */
  record(snap: HistorySnapshot) {
    // If the new snapshot is identical to the current one, skip — saves
    // the user from extra Cmd+Z presses on no-op edits (e.g. clicking a
    // selected shape without moving it).
    const cur = this._history[this._index];
    if (cur && sameSnapshot(cur, snap)) return;
    // Discard any redo entries past the current index.
    this._history.splice(this._index + 1);
    this._history.push(clone(snap));
    if (this._history.length > MAX_HISTORY) this._history.shift();
    this._index = this._history.length - 1;
  }

  /** Go back one checkpoint. Returns the snapshot to restore, or null. */
  undo(): HistorySnapshot | null {
    if (this._index <= 0) return null;
    this._index--;
    return clone(this._history[this._index]);
  }

  /** Go forward one checkpoint. Returns the snapshot to restore, or null. */
  redo(): HistorySnapshot | null {
    if (this._index >= this._history.length - 1) return null;
    this._index++;
    return clone(this._history[this._index]);
  }

  get canUndo(): boolean { return this._index > 0; }
  get canRedo(): boolean { return this._index < this._history.length - 1; }
}

function clone(snap: HistorySnapshot): HistorySnapshot {
  return {
    shapes: structuredClone(snap.shapes),
    flowEdges: structuredClone(snap.flowEdges),
    selectedIds: snap.selectedIds.slice(),
  };
}

function sameSnapshot(a: HistorySnapshot, b: HistorySnapshot): boolean {
  // Cheap-but-correct: serialise both and compare. The shapes/edges are
  // small (under a few KB even for big canvases) and JSON.stringify is
  // deterministic enough here that a string-equality check is reliable.
  return (
    JSON.stringify(a.shapes) === JSON.stringify(b.shapes) &&
    JSON.stringify(a.flowEdges) === JSON.stringify(b.flowEdges)
  );
}
