/**
 * A provider script module for `--provider-script` that answers identity decisions. The scores
 * (rubric levels 0..4) come from IDENTITY_TEST_SCORES, one per call, comma separated; default 1.
 * Vision calls (identity-cast and identity-check) answer from IDENTITY_TEST_VISION: texts separated
 * by "|", one per call, the last repeating; they throw when it is unset.
 */
export default {
  image: () => {
    throw new Error("no image generation in identity CLI tests");
  },
  vision: (_request: unknown, index: number) => {
    const texts = process.env["IDENTITY_TEST_VISION"]?.split("|");
    if (!texts) throw new Error("no vision calls in identity CLI tests");
    return { text: texts[Math.min(index, texts.length - 1)] as string, costUsd: 0.0001 };
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
