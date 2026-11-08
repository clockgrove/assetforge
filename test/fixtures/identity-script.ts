/**
 * A provider script module for `--provider-script` that answers identity decisions. The scores
 * (rubric levels 0..4) come from IDENTITY_TEST_SCORES, one per call, comma separated; default 1.
 */
export default {
  image: () => {
    throw new Error("no image generation in identity CLI tests");
  },
  vision: () => {
    throw new Error("no vision calls in identity CLI tests");
  },
  decide: (_request: unknown, index: number) => ({
    answer: {
      type: "score",
      score: Number(process.env["IDENTITY_TEST_SCORES"]?.split(",")[index] ?? 1),
    },
    confidence: 0.62,
    costUsd: 0.00003,
  }),
};
