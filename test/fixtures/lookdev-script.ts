/**
 * A scripted look-dev provider for tests and offline runs. Restyle calls answer with their render
 * warmed in colour (so the projected albedo visibly changes); the locate call puts both eyes and
 * the nose on the synthetic quadruped's head in the close-up (`SCRIPT_LOOKDEV_EYES` overrides the reply); groom calls
 * answer lengths per region, with a frosted tint for a season named `winter`. Markings calls name
 * no marking, unless `SCRIPT_LOOKDEV_MARKINGS` is `figure` (one marking, "patch", boxed on the middle
 * of each image's figure against its lower part) or a literal reply.
 */
import type { Script } from "../../src/gateway/scripted.ts";
import { decodeImage, encodePng } from "../../src/image/raster.ts";

const REGIONS = ["face", "cheek", "head", "neck", "body", "leg", "tail"];

/** The box, as fractions, of the pixels that differ from the image's corner colour. */
function figureBox(bytes: Uint8Array): [number, number, number, number] {
  const r = decodeImage(bytes);
  const bg = [r.data[0]!, r.data[1]!, r.data[2]!];
  let x0 = r.width;
  let y0 = r.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const o = (y * r.width + x) * 4;
      const d =
        Math.abs(r.data[o]! - bg[0]!) +
        Math.abs(r.data[o + 1]! - bg[1]!) +
        Math.abs(r.data[o + 2]! - bg[2]!);
      if (d <= 24) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  return x1 <= x0 ? [0, 0, 1, 1] : [x0 / r.width, y0 / r.height, x1 / r.width, y1 / r.height];
}

const script: Script = {
  image(request) {
    const render = decodeImage(request.references[0]!.bytes);
    for (let i = 0; i < render.data.length; i += 4) {
      const grey = render.data[i]! === 216 && render.data[i + 1]! === 216;
      if (grey) continue;
      render.data[i] = Math.min(255, render.data[i]! + 40);
      render.data[i + 2] = Math.max(0, render.data[i + 2]! - 20);
    }
    return { images: [{ mediaType: "image/png", bytes: encodePng(render) }], costUsd: 0.04 };
  },
  vision(request) {
    if (request.prompt.includes('"markings"')) {
      const markings = process.env["SCRIPT_LOOKDEV_MARKINGS"];
      if (!markings) return { text: JSON.stringify({ markings: [] }), costUsd: 0.001 };
      if (markings !== "figure") return { text: markings, costUsd: 0.001 };
      const boxes = request.images.map((ref) => {
        const [x0, y0, x1, y1] = figureBox(ref.bytes);
        const w = x1 - x0;
        const h = y1 - y0;
        return {
          mark: [x0 + w * 0.3, y0 + h * 0.3, x0 + w * 0.7, y0 + h * 0.6],
          ground: [x0 + w * 0.2, y0 + h * 0.6, x0 + w * 0.8, y0 + h * 0.9],
        };
      });
      return {
        text: JSON.stringify({ markings: [{ name: "patch", against: "lower body", boxes }] }),
        costUsd: 0.001,
      };
    }
    if (request.prompt.includes('"eyes"')) {
      return {
        text:
          process.env["SCRIPT_LOOKDEV_EYES"] ??
          JSON.stringify({
            eyes: [
              { x: 240, y: 250, r: 45 },
              { x: 270, y: 250, r: 45 },
            ],
            nose: { x: 255, y: 240, r: 12 },
          }),
        costUsd: 0.001,
      };
    }
    const winter = /winter coat/.test(request.prompt);
    const lengthMm = Object.fromEntries(
      REGIONS.map((r) => [r, (r === "face" ? 4 : r === "tail" ? 40 : 20) * (winter ? 1.6 : 1)]),
    );
    const density = Object.fromEntries(REGIONS.map((r) => [r, winter ? 0.9 : 0.6]));
    return {
      text: JSON.stringify({
        lengthMm,
        density,
        tint: winter ? { color: "#e8ecf2", tipWeight: 0.7 } : null,
      }),
      costUsd: 0.001,
    };
  },
  decide(_request, index) {
    return {
      answer: { type: "score", score: index % 2 === 0 ? 3.6 : 2.2 },
      confidence: 0.7,
      costUsd: 0.00002,
    };
  },
};

export default script;
