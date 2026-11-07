import { setPixel } from "./raster.ts";
import type { Raster } from "./raster.ts";

/** A 3x5 bitmap font for digits, used to number frames on contact sheets. */
const GLYPHS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

/** Width in pixels of `text` drawn at `scale` (one blank column between glyphs). */
export function textWidth(text: string, scale: number): number {
  return text.length === 0 ? 0 : (text.length * 4 - 1) * scale;
}

/** Draws the digits of `text` with their top-left at (x, y); other characters are skipped. */
export function drawDigits(
  r: Raster,
  text: string,
  x: number,
  y: number,
  scale: number,
  rgba: readonly number[],
): void {
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch];
    if (!glyph) return;
    glyph.forEach((row, gy) => {
      [...row].forEach((bit, gx) => {
        if (bit !== "1") return;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = x + (i * 4 + gx) * scale + sx;
            const py = y + gy * scale + sy;
            if (px >= 0 && py >= 0 && px < r.width && py < r.height) setPixel(r, px, py, rgba);
          }
        }
      });
    });
  });
}
