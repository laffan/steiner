// Canvas clipboard envelope shared with Hush. Both apps detect the same
// `schema` string and shape, so copy/paste round-trips between them.
//
// Format (text/plain JSON):
//   {
//     "schema": "canvas-clipboard@1",
//     "shapes": [...],
//     "flowEdges": [...]
//   }
//
// Field naming mirrors the in-memory Shape / FlowEdge types (camelCase).
// Unknown fields are preserved on round-trip but not relied on.

import type { Shape } from "./types";
import type { FlowEdge } from "./flowchart";
import { generateId } from "./utils";

export const CLIPBOARD_SCHEMA = "canvas-clipboard@1";

export interface ClipboardEnvelope {
  schema: typeof CLIPBOARD_SCHEMA;
  shapes: Shape[];
  flowEdges?: FlowEdge[];
  // Forward compatibility: ignore unknown extras.
  [k: string]: unknown;
}

export function encodeSelection(shapes: Shape[], edges: FlowEdge[]): string {
  const ids = new Set(shapes.map((s) => s.id));
  // Only carry edges whose endpoints are both in the copy set, so an orphan
  // edge never lands on the receiver.
  const carried = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const env: ClipboardEnvelope = {
    schema: CLIPBOARD_SCHEMA,
    shapes: shapes.map((s) => structuredClone(s)),
    flowEdges: carried.map((e) => ({ ...e })),
  };
  return JSON.stringify(env);
}

export function tryDecode(text: string): ClipboardEnvelope | null {
  if (!text) return null;
  // Cheap header check before parsing — clipboard text often isn't JSON at all.
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  if (!trimmed.includes(CLIPBOARD_SCHEMA)) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema !== CLIPBOARD_SCHEMA) return null;
    if (!Array.isArray(parsed.shapes)) return null;
    return parsed as ClipboardEnvelope;
  } catch {
    return null;
  }
}

export interface RemappedPaste {
  shapes: Shape[];
  edges: FlowEdge[];
  /** New IDs in the same order as the input shapes (handy for selecting after paste). */
  newIds: string[];
}

/**
 * Remap shape IDs and edge endpoints so a paste never collides with existing
 * canvas IDs. Edges referring to shapes outside the paste set are dropped.
 * parentId references are remapped when the parent is in the set, cleared
 * otherwise. Translates positions so the paste's bounding-box center lands at
 * `targetCenter` (canvas coordinates).
 */
export function remapForPaste(
  env: ClipboardEnvelope,
  targetCenter: { x: number; y: number },
): RemappedPaste {
  const idMap = new Map<string, string>();
  const newIds: string[] = [];
  for (const s of env.shapes) {
    const nid = generateId();
    idMap.set(s.id, nid);
    newIds.push(nid);
  }

  // Compute current bounds-center to translate the paste as a unit.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of env.shapes) {
    const pos = (s as { position?: { x: number; y: number } }).position;
    if (!pos) continue;
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
  }
  const haveBounds = isFinite(minX);
  const cx = haveBounds ? (minX + maxX) / 2 : 0;
  const cy = haveBounds ? (minY + maxY) / 2 : 0;
  const dx = haveBounds ? targetCenter.x - cx : 0;
  const dy = haveBounds ? targetCenter.y - cy : 0;

  const shapes: Shape[] = env.shapes.map((s) => {
    const clone = structuredClone(s);
    const cAny = clone as {
      id: string;
      parentId?: string;
      groupId?: string;
      position?: { x: number; y: number };
    };
    cAny.id = idMap.get(s.id)!;
    if (cAny.parentId) {
      cAny.parentId = idMap.get(cAny.parentId);
    }
    // Group IDs collide too; clear them to avoid accidentally joining a group
    // on paste. The user can re-group after.
    if (cAny.groupId) cAny.groupId = undefined;
    if (cAny.position) {
      cAny.position = { x: cAny.position.x + dx, y: cAny.position.y + dy };
    }
    return clone;
  });

  const edges: FlowEdge[] = (env.flowEdges || [])
    .map((e) => {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      if (!from || !to) return null;
      return { id: generateId(), from, to };
    })
    .filter((e): e is FlowEdge => !!e);

  return { shapes, edges, newIds };
}
