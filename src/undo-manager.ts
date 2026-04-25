import type { Shape } from "./types";

const MAX_HISTORY = 100;

/**
 * Snapshot-based undo/redo manager.
 *
 * History is an array of checkpoints (shape snapshots). The index points
 * to the "current" checkpoint. record() appends a new checkpoint after
 * the current index (discarding any redo entries). undo()/redo() move
 * the index and return the snapshot to restore.
 */
export class UndoManager {
  private _history: Shape[][] = [];
  private _index = -1;

  /** Capture the initial state. Call once on startup / after loading shapes. */
  init(shapes: Shape[]) {
    this._history = [structuredClone(shapes)];
    this._index = 0;
  }

  /** Record the shapes after a completed action (creates a new checkpoint). */
  record(shapes: Shape[]) {
    // Discard any redo entries past the current index
    this._history.splice(this._index + 1);
    this._history.push(structuredClone(shapes));
    // Enforce max history
    if (this._history.length > MAX_HISTORY) {
      this._history.shift();
    }
    this._index = this._history.length - 1;
  }

  /** Go back one checkpoint. Returns the shapes to restore, or null if at the start. */
  undo(): Shape[] | null {
    if (this._index <= 0) return null;
    this._index--;
    return structuredClone(this._history[this._index]);
  }

  /** Go forward one checkpoint. Returns the shapes to restore, or null if at the end. */
  redo(): Shape[] | null {
    if (this._index >= this._history.length - 1) return null;
    this._index++;
    return structuredClone(this._history[this._index]);
  }

  get canUndo(): boolean { return this._index > 0; }
  get canRedo(): boolean { return this._index < this._history.length - 1; }
}
