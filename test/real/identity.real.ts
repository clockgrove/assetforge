import assert from "node:assert/strict";
import { test } from "node:test";
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { IDENTITY_LEVELS } from "../../src/identity.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { defaultRoutes } from "../../src/routes.ts";

const skip = process.env["AI_GATEWAY_API_KEY"] ? false : "AI_GATEWAY_API_KEY not set";

/** A synthetic 384 px square: a filled circle of one colour on transparency. */
function disc(rgb: [number, number, number]): Uint8Array {
  const size = 384;
  const r = createRaster(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if ((x - size / 2) ** 2 + (y - size / 2) ** 2 < (size / 3) ** 2)
        setPixel(r, x, y, [...rgb, 255]);
  return encodePng(r);
}

test(
  "real gateway: one typed identity decision (Score) with reference images",
  { skip },
  async () => {
    const result = await VercelGateway.fromEnv().decide({
      model: defaultRoutes.identity.model,
      prompt:
        "Image 1 is the candidate. Image 2 is the approved reference. Identity record: a plain red disc.",
      images: [
        { mediaType: "image/png", bytes: disc([220, 30, 30]) },
        { mediaType: "image/png", bytes: disc([220, 30, 30]) },
      ],
      question: {
        type: "score",
        instructions: "How well does image 1 match the identity record?",
        levels: [...IDENTITY_LEVELS],
      },
    });
    assert.equal(result.answer.type, "score");
    if (result.answer.type === "score") {
      assert.ok(result.answer.score >= 0 && result.answer.score <= IDENTITY_LEVELS.length - 1);
    }
    assert.equal(result.requestIdSource, "provider", `request ID ${result.requestId}`);
    assert.equal(typeof result.costUsd, "number", "the gateway reports the call's cost");
  },
);
