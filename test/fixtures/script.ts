/** A provider script module for `--provider-script`: passes QA, mirroring scriptedProvider. */
import { encodePng } from "../../src/image/raster.ts";
import { drawSubject } from "./synthetic.ts";

const CHECKS = ["transparency", "frame-count", "identity", "perspective"];

export default {
  image: (request: { prompt: string }) => {
    const m = /frame (\d+) of/.exec(request.prompt);
    return {
      images: [
        { mediaType: "image/png", bytes: encodePng(drawSubject(96, m?.[1] ? Number(m[1]) : 0)) },
      ],
    };
  },
  vision: () => ({
    text:
      "```json\n" +
      JSON.stringify({ checks: CHECKS.map((check) => ({ check, passed: true, reason: "ok" })) }) +
      "\n```",
  }),
};
