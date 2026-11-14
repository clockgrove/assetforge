/**
 * A provider script module for `--provider-script` on the animation commands: every flicker call
 * answers "same", unless the pair names frame 3 as its second image, which is labelled a flicker;
 * every holes call answers that the areas are openings between parts; every edit returns a
 * synthetic figure with alpha. Nothing here is real art.
 */
import { encodePng } from "../../src/image/raster.ts";
import { syntheticStrip } from "./strip.ts";

const figure = syntheticStrip({ count: 8, style: "painterly", motion: "walk" }).frames[2];

export default {
  image: () => ({
    images: [{ mediaType: "image/png", bytes: encodePng(figure as never) }],
    costUsd: 0.04,
  }),
  vision: (request: { prompt: string }) => {
    if (/Magenta marks/.test(request.prompt)) {
      return {
        text: JSON.stringify({
          holes: false,
          areas: [{ where: "between the legs", kind: "opening" }],
          confidence: 0.9,
        }),
        costUsd: 0.003,
      };
    }
    const flicker = /image 2 is frame 3\b/.test(request.prompt);
    return {
      text: JSON.stringify(
        flicker
          ? { label: "flicker", confidence: 0.91, reason: "the tail rings change colour" }
          : { label: "same", confidence: 0.97, reason: "same fox" },
      ),
      costUsd: 0.01,
    };
  },
};
