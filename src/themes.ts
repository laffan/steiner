/** Canvas theme palettes derived from CodeMirror themes (thememirror.net). */

export type AppearanceMode = "light" | "dark" | "auto";

export interface CanvasTheme {
  name: string;
  variant: "light" | "dark";
  background: string;
  canvasBackground: string;
  foreground: string;
  /** Secondary text color used for markdown headings */
  headingColor: string;
  selection: string;
  accent: string;
  gridColor: string;
  uiBackground: string;
  uiBorder: string;
}

function light(name: string, bg: string, fg: string, heading: string, sel: string, accent: string): CanvasTheme {
  return {
    name, variant: "light", background: bg, canvasBackground: bg,
    foreground: fg, headingColor: heading, selection: sel, accent,
    gridColor: "#e2e5e9", uiBackground: "rgba(255,255,255,0.95)", uiBorder: "#e5e7eb",
  };
}

function dark(name: string, bg: string, fg: string, heading: string, sel: string, accent: string): CanvasTheme {
  return {
    name, variant: "dark", background: bg, canvasBackground: bg,
    foreground: fg, headingColor: heading, selection: sel, accent,
    gridColor: "rgba(255,255,255,0.06)", uiBackground: "rgba(40,40,50,0.95)", uiBorder: "rgba(255,255,255,0.1)",
  };
}

export const THEMES: Record<string, CanvasTheme> = {
  // Light themes
  "default":         light("Default",         "#f4f5f7", "#000000", "#4285f4", "#4285f4", "#4285f4"),
  "tomorrow":        light("Tomorrow",        "#FFFFFF", "#4D4D4C", "#8959A8", "#D6D6D6", "#F5871F"),
  "ayu-light":       light("Ayu Light",       "#fcfcfc", "#5c6166", "#fa8d3e", "#036dd6", "#ffaa33"),
  "clouds":          light("Clouds",          "#ffffff", "#000000", "#46A609", "#BDD5FC", "#46A609"),
  "espresso":        light("Espresso",        "#FFFFFF", "#000000", "#2F6F9F", "#80C7FF", "#4F9FD0"),
  "noctis-lilac":    light("Noctis Lilac",    "#f2f1f8", "#0c006b", "#ff5792", "#d5d1f2", "#ff5792"),
  "rose-pine-dawn":  light("Rose Pine Dawn",  "#faf4ed", "#575279", "#d7827e", "#dfdad0", "#d7827e"),
  "solarized-light": light("Solarized Light", "#fef7e5", "#586E75", "#268BD2", "#073642", "#D30102"),
  // Dark themes
  "dracula":         dark("Dracula",           "#2d2f3f", "#f8f8f2", "#bd93f9", "#44475a", "#bd93f9"),
  "cobalt":          dark("Cobalt",            "#00254b", "#FFFFFF", "#80FFC2", "#B36539", "#80FFC2"),
  "amy":             dark("Amy",               "#200020", "#D0D0FF", "#60B0FF", "#800000", "#7090B0"),
  "cool-glow":       dark("Cool Glow",         "#060521", "#E0E0E0", "#A3EBFF", "#122BBB", "#A3EBFF"),
  "barf":            dark("Barf",              "#15191E", "#EEF2F7", "#A3D295", "#90B2D5", "#C1E1B8"),
  "bespin":          dark("Bespin",            "#2e241d", "#BAAE9E", "#E9C062", "#DDF0FF", "#E9C062"),
  "boys-and-girls":  dark("Boys & Girls",      "#000205", "#FFFFFF", "#00D8FF", "#E60C65", "#E62286"),
  "birds-of-paradise": dark("Birds of Paradise", "#3b2627", "#E6E1C4", "#EFAC32", "#16120E", "#EFAC32"),
};

export const THEME_IDS = Object.keys(THEMES);

export function getEffectiveVariant(mode: AppearanceMode): "light" | "dark" {
  if (mode === "auto") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}
