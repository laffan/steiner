// === Tools ===
export type Tool = "select" | "text" | "drag-area" | "brainstorm";

// === Geometry ===
export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// === Camera ===
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface CameraBookmark {
  id: string;
  name: string;
  camera: Camera;
}

// === Shapes ===
export const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
export const LINE_HEIGHT_RATIO = 1.3;

interface ShapeBase {
  id: string;
  color: string;
  parentId?: string; // id of drag-area parent, if any
  groupId?: string;  // shared id for logically grouped shapes
  pocketed?: boolean;  // true if shape is pocketed to right-side zone
}

export interface DrawShape extends ShapeBase {
  type: "draw";
  points: Point[];
  width: number;
}

export interface TextShape extends ShapeBase {
  type: "text";
  position: Point;
  text: string;
  fontSize: number;
  width?: number; // constraint width for wrapping; undefined = auto-size
  manualWidth?: boolean; // true if user explicitly resized via handles
  backgroundColor?: string;
}

export interface ImageCrop {
  /** Crop region as fractions (0-1) of the full image */
  x: number; y: number; w: number; h: number;
}

export interface ImageShape extends ShapeBase {
  type: "image";
  position: Point;
  width: number;
  height: number;
  dataUrl: string;
  name: string;
  crop?: ImageCrop;
}

export interface DragAreaShape extends ShapeBase {
  type: "drag-area";
  position: Point;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  borderRadius: number;
}

export type Shape = DrawShape | TextShape | ImageShape | DragAreaShape;

// === Selection ===
export interface SelectionBox {
  start: Point;
  end: Point;
}

// === Color palette ===
export const COLOR_PALETTE: Record<string, string> = {
  black: "#000000",
  gray: "#6b7280",
  red: "#ea4335",
  orange: "#ff9800",
  yellow: "#fbbc04",
  green: "#34a853",
  blue: "#4285f4",
  violet: "#9c27b0",
  "light-red": "#ffb3ba",
  "light-green": "#90ee90",
  "light-blue": "#87ceeb",
  "light-violet": "#dda0dd",
};

export const BACKGROUND_COLORS = ["reset", "gray", "light-blue", "light-green", "orange", "red", "violet"] as const;
export const TEXT_COLORS = ["reset", "gray", "light-blue", "light-green", "orange", "red", "violet"] as const;

// === Shelf ===
export interface ShelfNode {
  id: string;
  type: "text" | "image" | "drag-area" | "group";
  label: string;
  excerpt: string;
  shapeId: string;
  parentId: string | null;
  childIds: string[];
  color: string | null;
  depth: number;
  pinned: boolean;
}
