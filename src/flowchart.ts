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
      arrowColor: config.arrowColor ?? "#666",
      arrowWidth: config.arrowWidth ?? 1.5,
      arrowHeadSize: config.arrowHeadSize ?? 9,
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

  // --- Rendering ---

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

    for (const e of this.edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const ab = this.cfg.getBounds(a);
      const bb = this.cfg.getBounds(b);

      // Pick the side of each box closer to the other so the arrow looks
      // sane even if the user drags the child to the parent's left/below.
      const childOnRight = (bb.minX + bb.maxX) / 2 >= (ab.minX + ab.maxX) / 2;
      const sx = childOnRight ? ab.maxX : ab.minX;
      const sy = (ab.minY + ab.maxY) / 2;
      const tx = childOnRight ? bb.minX : bb.maxX;
      const ty = (bb.minY + bb.maxY) / 2;

      const dx = Math.max(40, Math.abs(tx - sx) * 0.5);
      const cp1x = childOnRight ? sx + dx : sx - dx;
      const cp2x = childOnRight ? tx - dx : tx + dx;

      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(cp1x, sy, cp2x, ty, tx, ty);
      ctx.stroke();

      // Arrowhead. Use the tangent at the curve's end (cp2 → end) for direction.
      const angle = Math.atan2(ty - ty /* dummy */, tx - cp2x); // along x-ish
      // Better: compute the actual derivative at t=1 of the cubic bezier.
      // dB/dt at t=1 = 3 * (P3 - P2). Here P2 = (cp2x, ty) and P3 = (tx, ty),
      // so the tangent is (3*(tx-cp2x), 0) — horizontal. Good enough.
      const ah = this.cfg.arrowHeadSize;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      const px = -dirY;
      const py = dirX;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(
        tx - ah * dirX + (ah * 0.55) * px,
        ty - ah * dirY + (ah * 0.55) * py,
      );
      ctx.lineTo(
        tx - ah * dirX - (ah * 0.55) * px,
        ty - ah * dirY - (ah * 0.55) * py,
      );
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
