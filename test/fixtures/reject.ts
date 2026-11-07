/** A provider script module whose vision verdict always fails identity. */
import passing from "./script.ts";

export default {
  image: passing.image,
  vision: () => ({
    text:
      "```json\n" +
      JSON.stringify({
        checks: ["transparency", "frame-count", "identity", "perspective"].map((check) => ({
          check,
          passed: check !== "identity",
          reason: "scripted",
        })),
      }) +
      "\n```",
  }),
};
