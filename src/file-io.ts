/** Save and open .note files (zip containing data.json + images/) */
import JSZip from "jszip";
import type { Shape, ImageShape } from "./types";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, readFile } from "@tauri-apps/plugin-fs";

export interface NoteFile {
  shapes: Shape[];
}

/**
 * Prompt native save dialog, then write a .note zip file.
 * Images are extracted from dataUrl and stored in an images/ folder.
 */
export async function saveNoteFile(shapes: Shape[]): Promise<boolean> {
  const path = await save({
    title: "Save Note",
    defaultPath: "untitled.note",
    filters: [{ name: "Note", extensions: ["note"] }],
  });
  if (!path) return false;

  const zip = new JSZip();
  const imgFolder = zip.folder("images")!;
  let imgIndex = 0;

  const exportShapes = shapes.map((s) => {
    if (s.type !== "image") return s;
    const imgShape = s as ImageShape;
    const ext = guessExtension(imgShape.dataUrl);
    const imgFilename = `img_${imgIndex++}${ext}`;
    const base64 = imgShape.dataUrl.split(",")[1];
    if (base64) imgFolder.file(imgFilename, base64, { base64: true });
    return { ...imgShape, dataUrl: `images/${imgFilename}` };
  });

  zip.file("data.json", JSON.stringify({ shapes: exportShapes }, null, 2));
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await writeFile(path, bytes);
  return true;
}

/**
 * Prompt native open dialog, then read and parse a .note zip file.
 */
export async function openNoteFile(): Promise<Shape[] | null> {
  const path = await open({
    title: "Open Note",
    filters: [{ name: "Note", extensions: ["note", "zip"] }],
    multiple: false,
    directory: false,
  });
  if (!path) return null;

  const bytes = await readFile(path as string);
  const zip = await JSZip.loadAsync(bytes);
  const dataFile = zip.file("data.json");
  if (!dataFile) throw new Error("Invalid .note file: missing data.json");

  const json = await dataFile.async("string");
  const noteData: NoteFile = JSON.parse(json);

  const shapes = await Promise.all(noteData.shapes.map(async (s) => {
    if (s.type !== "image") return s;
    const imgShape = s as ImageShape;
    if (imgShape.dataUrl.startsWith("data:")) return s;
    const imgFile = zip.file(imgShape.dataUrl);
    if (!imgFile) return s;
    const data = await imgFile.async("base64");
    const ext = imgShape.dataUrl.split(".").pop() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : `image/${ext}`;
    return { ...imgShape, dataUrl: `data:${mime};base64,${data}` };
  }));

  return shapes;
}

function guessExtension(dataUrl: string): string {
  if (dataUrl.includes("image/png")) return ".png";
  if (dataUrl.includes("image/jpeg") || dataUrl.includes("image/jpg")) return ".jpg";
  if (dataUrl.includes("image/webp")) return ".webp";
  if (dataUrl.includes("image/gif")) return ".gif";
  if (dataUrl.includes("image/svg")) return ".svg";
  return ".png";
}
