/**
 * A scripted look-dev provider for tests and offline runs. Restyle calls answer with their render
 * warmed in colour (so the projected albedo visibly changes); the locate call puts both eyes and
 * the nose near the close-up's centre (`SCRIPT_LOOKDEV_EYES` overrides the reply); groom calls
 * answer lengths per region, with a frosted tint for a season named `winter`.
 */
import type { Script } from "../../src/gateway/scripted.ts";
import { decodeImage, encodePng } from "../../src/image/raster.ts";

const REGIONS = ["face", "cheek", "head", "neck", "body", "leg", "tail"];

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
    if (request.prompt.includes('"eyes"')) {
      return {
        text:
          process.env["SCRIPT_LOOKDEV_EYES"] ??
          JSON.stringify({
            eyes: [
              { x: 236, y: 240, r: 14 },
              { x: 276, y: 240, r: 14 },
            ],
            nose: { x: 256, y: 270, r: 10 },
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
