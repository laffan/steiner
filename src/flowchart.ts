// Flowchart layer — a portable add-on for canvas apps with a "text object"
// architecture. Knows nothing about the host app's specific shape types
// beyond what it's told via the config callbacks (getBounds, isFlowable).
//
// Usage:
//
//   const flow = new FlowchartLayer<Shape>({
//     getBounds: (s) => getShapeBounds(s),
//     isFlowable: (s) => s.type === "text",
//   });
//
//   // On drop:
//   const target = flow.findDropTarget(droppedCenter, shapes, droppedId);
//   if (target) {
//     const newTL = flow.tryConnect(droppedId, target.id, shapes);
//     if (newTL) {
//       // Translate from "new bounds top-left" to "new shape position".
//       const old = getShapeBounds(droppedShape);
//       applyPositionDelta(droppedId, newTL.minX - old.minX, newTL.minY - old.minY);
//     }
//   }
//
//   // On render (after camera transform is applied):
//   flow.draw(ctx, shapes);
//
//   // On node deletion:
//   flow.removeNode(deletedId);
//
//   // Tidy a subtree (anchors root, repositions descendants):
//   const layout = flow.tidy(rootId, shapes);
//   for (const [id, tl] of layout) {
//     const old = getShapeBounds(shapes.find((s) => s.id === id)!);
//     applyPositionDelta(id, tl.minX - old.minX, tl.minY - old.minY);
//   }
//
//   // Persistence:
//   const data = flow.serialize();
//   flow.deserialize(loadedData);

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

export interface FlowNode {
  id: string;
}

export interface FlowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FlowchartConfig<S extends FlowNode> {
  /** Returns the canvas-space bounds of the node. */
  getBounds: (node: S) => FlowBounds;
  /** Predicate for which nodes can be flowchart vertices. Defaults to all. */
  isFlowable?: (node: S) => boolean;
  /** Horizontal gap between parent's right edge and child's left edge. */
  gapX?: number;
  /** Vertical gap between siblings stacked under the parent. */
  gapY?: number;
  /** Horizontal parent→child gap used by `tidy`. */
  tidyGapX?: number;
  /** Vertical sibling gap used by `tidy`. */
  tidyGapY?: number;
  /** Stroke color for the arrows. */
  arrowColor?: string;
  /** Arrow line width (canvas units). */
  arrowWidth?: number;
  /** Arrowhead size (canvas units). */
  arrowHeadSize?: number;
}

interface ResolvedConfig<S extends FlowNode> {
  getBounds: (node: S) => FlowBounds;
  isFlowable: (node: S) => boolean;
  gapX: number;
  gapY: number;
  tidyGapX: number;
  tidyGapY: number;
  arrowColor: string;
  arrowWidth: number;
  arrowHeadSize: number;
}

export class FlowchartLayer<S extends FlowNode> {
  edges: FlowEdge[] = [];
  private cfg: ResolvedConfig<S>;

  constructor(config: FlowchartConfig<S>) {
    this.cfg = {
      getBounds: config.getBounds,
      isFlowable: config.isFlowable ?? (() => true),
      gapX: config.gapX ?? 60,
      gapY: config.gapY ?? 16,
      tidyGapX: config.tidyGapX ?? 150,
      tidyGapY: config.tidyGapY ?? 25,
      arrowColor: config.arrowColor ?? "#666",
      arrowWidth: config.arrowWidth ?? 1.5,
      arrowHeadSize: config.arrowHeadSize ?? 11,
    };
  }

  // --- State ---

  serialize(): FlowEdge[] {
    return this.edges.map((e) => ({ ...e }));
  }

  deserialize(edges: FlowEdge[] | undefined | null): void {
    this.edges = Array.isArray(edges) ? edges.map((e) => ({ ...e })) : [];
  }

  hasEdge(from: string, to: string): boolean {
    return this.edges.some((e) => e.from === from && e.to === to);
  }

  parentOf(childId: string): string | null {
    const e = this.edges.find((e) => e.to === childId);
    return e ? e.from : null;
  }

  childrenOf(parentId: string): string[] {
    return this.edges.filter((e) => e.from === parentId).map((e) => e.to);
  }

  /** All descendants of `id` (transitive). Used for cycle prevention. */
  descendantsOf(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const c of this.childrenOf(cur)) {
        if (!out.has(c)) {
          out.add(c);
          stack.push(c);
        }
      }
    }
    return out;
  }

  /** Remove every edge that references this node. */
  removeNode(id: string): void {
    this.edges = this.edges.filter((e) => e.from !== id && e.to !== id);
  }

  /** Add an edge from `from` to `to`. Replaces any existing parent for `to`.
   * Caller is responsible for cycle prevention if needed. */
  addEdge(from: string, to: string): FlowEdge {
    this.edges = this.edges.filter((e) => e.to !== to);
    const edge: FlowEdge = { id: genId(), from, to };
    this.edges.push(edge);
    return edge;
  }

  /** Remove a single edge by id. No-op if not found. */
  removeEdge(edgeId: string): void {
    this.edges = this.edges.filter((e) => e.id !== edgeId);
  }

  /**
   * Find the edge whose curve passes within `threshold` units of `point`.
   * Returns null if none. Threshold is in canvas units — callers should
   * scale by 1/zoom for a screen-space threshold.
   */
  findEdgeNear(
    point: { x: number; y: number },
    shapes: S[],
    threshold: number,
  ): FlowEdge | null {
    let best: FlowEdge | null = null;
    let bestDist = threshold;
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);
    for (const e of this.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const geom = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));
      // Sample 16 points along the bezier and check each segment.
      let prev = bezier(geom, 0);
      for (let i = 1; i <= 16; i++) {
        const cur = bezier(geom, i / 16);
        const d = pointToSegment(point, prev, cur);
        if (d < bestDist) {
          bestDist = d;
          best = e;
        }
        prev = cur;
      }
    }
    return best;
  }

  /** Midpoint of the edge's curve (t = 0.5), in canvas coordinates. */
  getEdgeMidpoint(
    edgeId: string,
    shapes: S[],
  ): { x: number; y: number } | null {
    const e = this.edges.find((e) => e.id === edgeId);
    if (!e) return null;
    const a = shapes.find((s) => s.id === e.from);
    const b = shapes.find((s) => s.id === e.to);
    if (!a || !b) return null;
    const geom = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));
    return bezier(geom, 0.5);
  }

  // --- Drop logic ---

  /**
   * Find the topmost flowable node whose bounds contain `point`, ignoring
   * `excludeId`. Iterates in reverse — assumes later items in `shapes` are
   * drawn on top.
   */
  findDropTarget(
    point: { x: number; y: number },
    shapes: S[],
    excludeId: string,
  ): S | null {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.id === excludeId) continue;
      if (!this.cfg.isFlowable(s)) continue;
      const b = this.cfg.getBounds(s);
      if (
        point.x >= b.minX &&
        point.x <= b.maxX &&
        point.y >= b.minY &&
        point.y <= b.maxY
      ) {
        return s;
      }
    }
    return null;
  }

  /**
   * Wire `droppedId` as a child of `targetId`, replacing any existing parent.
   * Returns the new top-left of the dropped node's bounding box (in canvas
   * coordinates), or null if the connection is rejected (cycle, missing
   * shapes, non-flowable, self-drop).
   *
   * The caller translates this to a shape-specific position update — e.g.
   *   delta = newTL - oldBounds.{minX,minY}; shape.position += delta
   */
  tryConnect(
    droppedId: string,
    targetId: string,
    shapes: S[],
  ): { minX: number; minY: number } | null {
    if (droppedId === targetId) return null;
    if (this.descendantsOf(droppedId).has(targetId)) return null;
    const target = shapes.find((s) => s.id === targetId);
    const dropped = shapes.find((s) => s.id === droppedId);
    if (!target || !dropped) return null;
    if (!this.cfg.isFlowable(target) || !this.cfg.isFlowable(dropped)) return null;

    // Detach from prior parent (if any), then attach to new.
    this.edges = this.edges.filter((e) => e.to !== droppedId);
    this.edges.push({ id: genId(), from: targetId, to: droppedId });

    return this.computeTopLeftUnder(target, dropped, shapes);
  }

  private computeTopLeftUnder(
    target: S,
    dropped: S,
    shapes: S[],
  ): { minX: number; minY: number } {
    const tb = this.cfg.getBounds(target);

    // Stack below any existing children of target (other than the dropped one).
    let baseY = tb.minY;
    for (const cid of this.childrenOf(target.id)) {
      if (cid === dropped.id) continue;
      const c = shapes.find((s) => s.id === cid);
      if (!c) continue;
      const cb = this.cfg.getBounds(c);
      if (cb.maxY + this.cfg.gapY > baseY) baseY = cb.maxY + this.cfg.gapY;
    }
    return {
      minX: tb.maxX + this.cfg.gapX,
      minY: baseY,
    };
  }

  // --- Tidy ---

  /**
   * Re-layout the subtree rooted at `rootId`. The root stays anchored at its
   * current top-left; every descendant is repositioned so that:
   *   - Each child's left edge sits `tidyGapX` past its parent's right edge.
   *   - Sibling subtrees are stacked vertically with `tidyGapY` between their
   *     bounding boxes — which guarantees no overlap regardless of how deep
   *     or wide individual subtrees grow, since each subtree occupies a
   *     disjoint horizontal band relative to its siblings.
   *   - Each parent is vertically centered against the block of its children.
   *
   * Nodes can be any size at any level; sibling stacking uses the full
   * subtree bounding box (not just the child node's own bounds) so that a
   * deep child subtree can't collide with a shallow sibling beside it.
   *
   * Returns a Map<id, { minX, minY }> giving the new top-left of the root
   * and every descendant. Empty if `rootId` isn't in `shapes`. The caller
   * applies the move via the same delta pattern as `tryConnect`:
   *
   *   for (const [id, tl] of layout) {
   *     const old = getBounds(byId.get(id)!);
   *     translate(id, tl.minX - old.minX, tl.minY - old.minY);
   *   }
   *
   * Per-call gap overrides are accepted via `opts`.
   */
  tidy(
    rootId: string,
    shapes: S[],
    opts?: { tidyGapX?: number; tidyGapY?: number },
  ): Map<string, { minX: number; minY: number }> {
    const out = new Map<string, { minX: number; minY: number }>();
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);
    const root = byId.get(rootId);
    if (!root) return out;

    const gapX = opts?.tidyGapX ?? this.cfg.tidyGapX;
    const gapY = opts?.tidyGapY ?? this.cfg.tidyGapY;

    // Defensive cycle guard: even though tryConnect/addEdge enforce a tree,
    // bad data could yield cycles and this recursion has no other backstop.
    const visited = new Set<string>();

    // Recursively assign each node a top-left (minX, minY) in a coordinate
    // system local to the subtree (subtree's own top-left == (0, 0)).
    // Returns the subtree's bounding-box size.
    const layout = (id: string): { width: number; height: number } => {
      if (visited.has(id)) return { width: 0, height: 0 };
      visited.add(id);
      const node = byId.get(id);
      if (!node) return { width: 0, height: 0 };
      const nb = this.cfg.getBounds(node);
      const nw = nb.maxX - nb.minX;
      const nh = nb.maxY - nb.minY;

      const childIds = this.childrenOf(id).filter((c) => byId.has(c) && !visited.has(c));
      if (childIds.length === 0) {
        out.set(id, { minX: 0, minY: 0 });
        return { width: nw, height: nh };
      }

      const childSizes: { id: string; width: number; height: number }[] = [];
      for (const cid of childIds) {
        childSizes.push({ id: cid, ...layout(cid) });
      }

      // Combined height of children stacked with gapY between subtree boxes.
      let stackedH = 0;
      for (let i = 0; i < childSizes.length; i++) {
        stackedH += childSizes[i].height;
        if (i < childSizes.length - 1) stackedH += gapY;
      }
      // The maximum child subtree width (children may have different depths).
      let maxChildW = 0;
      for (const c of childSizes) {
        if (c.width > maxChildW) maxChildW = c.width;
      }

      const subtreeH = Math.max(nh, stackedH);
      const subtreeW = nw + gapX + maxChildW;

      // Place this node at left edge, centered vertically within the subtree.
      out.set(id, { minX: 0, minY: (subtreeH - nh) / 2 });

      // Place each child subtree to the right and stack them vertically,
      // centered against the subtree's vertical span.
      const childOffsetX = nw + gapX;
      let cursorY = (subtreeH - stackedH) / 2;
      for (const ch of childSizes) {
        shiftSubtree(ch.id, childOffsetX, cursorY);
        cursorY += ch.height + gapY;
      }

      return { width: subtreeW, height: subtreeH };
    };

    // Translate every position already assigned within the subtree of `id`.
    const shiftSubtree = (id: string, dx: number, dy: number): void => {
      const seen = new Set<string>();
      const stack = [id];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const p = out.get(cur);
        if (p) {
          p.minX += dx;
          p.minY += dy;
        }
        for (const c of this.childrenOf(cur)) {
          if (byId.has(c)) stack.push(c);
        }
      }
    };

    layout(rootId);

    // Anchor: shift the whole layout so the root keeps its current top-left.
    const rootBounds = this.cfg.getBounds(root);
    const rootRel = out.get(rootId);
    if (!rootRel) return out;
    const ox = rootBounds.minX - rootRel.minX;
    const oy = rootBounds.minY - rootRel.minY;
    for (const p of out.values()) {
      p.minX += ox;
      p.minY += oy;
    }
    return out;
  }

  // --- Rendering ---

  private geometry(ab: FlowBounds, bb: FlowBounds): EdgeGeometry {
    // Pick the side of each box closer to the other so the arrow looks sane
    // even if the user drags the child to the parent's left/below.
    const childOnRight = (bb.minX + bb.maxX) / 2 >= (ab.minX + ab.maxX) / 2;
    const sx = childOnRight ? ab.maxX : ab.minX;
    const sy = (ab.minY + ab.maxY) / 2;
    const sign = childOnRight ? 1 : -1;
    // Visual breathing room: tip stops 10px shy of the child's edge.
    const TIP_GAP = 10;
    const tipX = childOnRight ? bb.minX - TIP_GAP : bb.maxX + TIP_GAP;
    const tipY = (bb.minY + bb.maxY) / 2;
    // Back the line off by `ah` more so it terminates at the BASE of the
    // arrowhead (rather than the tip). Tangent at t=1 is horizontal by
    // construction.
    const ah = this.cfg.arrowHeadSize;
    const ex = tipX - sign * ah;
    const ey = tipY;
    const dx = Math.max(40, Math.abs(ex - sx) * 0.5);
    const cp1x = sx + sign * dx;
    const cp2x = ex - sign * dx;
    return {
      p0: { x: sx, y: sy },
      cp1: { x: cp1x, y: sy },
      cp2: { x: cp2x, y: ey },
      p3: { x: ex, y: ey },
      tip: { x: tipX, y: tipY },
      sign,
    };
  }

  /**
   * Draw all edges as cubic-bezier arrows from the right edge of the parent
   * to the left edge of the child. Call after the camera transform is
   * applied (canvas space).
   */
  draw(ctx: CanvasRenderingContext2D, shapes: S[]): void {
    if (this.edges.length === 0) return;
    const byId = new Map<string, S>();
    for (const s of shapes) byId.set(s.id, s);

    ctx.save();
    ctx.strokeStyle = this.cfg.arrowColor;
    ctx.fillStyle = this.cfg.arrowColor;
    ctx.lineWidth = this.cfg.arrowWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const ah = this.cfg.arrowHeadSize;
    for (const e of this.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const g = this.geometry(this.cfg.getBounds(a), this.cfg.getBounds(b));

      // Bezier from parent edge to base of arrowhead.
      ctx.beginPath();
      ctx.moveTo(g.p0.x, g.p0.y);
      ctx.bezierCurveTo(g.cp1.x, g.cp1.y, g.cp2.x, g.cp2.y, g.p3.x, g.p3.y);
      ctx.stroke();

      // Arrowhead — base at p3, tip at .tip.
      const px = 0;
      const py = g.sign;
      ctx.beginPath();
      ctx.moveTo(g.tip.x, g.tip.y);
      ctx.lineTo(g.p3.x + ah * 0.55 * px, g.p3.y + ah * 0.55 * py);
      ctx.lineTo(g.p3.x - ah * 0.55 * px, g.p3.y - ah * 0.55 * py);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Override the arrow color at runtime (e.g. for a theme change). */
  setArrowColor(color: string): void {
    this.cfg.arrowColor = color;
  }
}

function genId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

interface Pt {
  x: number;
  y: number;
}

interface EdgeGeometry {
  p0: Pt;
  cp1: Pt;
  cp2: Pt;
  /** End of the line — base of the arrowhead. */
  p3: Pt;
  /** Tip of the arrowhead — touches the child shape's edge. */
  tip: Pt;
  /** +1 if child is to the right of parent, -1 if to the left. */
  sign: number;
}

function bezier(g: EdgeGeometry, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * g.p0.x + b * g.cp1.x + c * g.cp2.x + d * g.p3.x,
    y: a * g.p0.y + b * g.cp1.y + c * g.cp2.y + d * g.p3.y,
  };
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
