#!/usr/bin/env node
// Fetches binary assets (fonts and app icons) from the upstream tauri-drawing
// repo. They aren't checked into this repo because the workflow that created
// it can't push binary blobs through the GitHub REST proxy. Run once after
// cloning:
//
//   npm run setup:assets
//
// Idempotent — skips files already present.

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://raw.githubusercontent.com/laffan/tauri-drawing/main";

const files = [
  "public/fonts/eb-garamond.woff2",
  "public/fonts/fira-code.woff2",
  "public/fonts/inter.woff2",
  "public/fonts/karla.woff2",
  "public/fonts/libre-baskerville.woff2",
  "public/fonts/libre-franklin.woff2",
  "public/fonts/lora.woff2",
  "public/fonts/source-sans-3.woff2",
  "public/fonts/source-serif-4.woff2",
  "src-tauri/icons/32x32.png",
  "src-tauri/icons/128x128.png",
  "src-tauri/icons/128x128@2x.png",
  "src-tauri/icons/icon.icns",
  "src-tauri/icons/icon.ico",
  "src-tauri/icons/icon.png",
  "src-tauri/icons/Square30x30Logo.png",
  "src-tauri/icons/Square44x44Logo.png",
  "src-tauri/icons/Square71x71Logo.png",
  "src-tauri/icons/Square89x89Logo.png",
  "src-tauri/icons/Square107x107Logo.png",
  "src-tauri/icons/Square142x142Logo.png",
  "src-tauri/icons/Square150x150Logo.png",
  "src-tauri/icons/Square284x284Logo.png",
  "src-tauri/icons/Square310x310Logo.png",
  "src-tauri/icons/StoreLogo.png",
];

let fetched = 0;
let skipped = 0;
let failed = 0;

for (const rel of files) {
  const dest = join(ROOT, rel);
  if (existsSync(dest) && statSync(dest).size > 0) {
    skipped++;
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const url = `${BASE}/${rel}`;
  process.stdout.write(`  ${rel} ... `);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    console.log(`${buf.length} bytes`);
    fetched++;
  } catch (err) {
    console.log(`FAIL (${err.message})`);
    failed++;
  }
}

console.log(`\n${fetched} fetched, ${skipped} already present, ${failed} failed.`);
if (failed > 0) process.exit(1);
