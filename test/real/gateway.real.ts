import assert from "node:assert/strict";
import { test } from "node:test";
import { VercelGateway } from "../../src/gateway/vercel.ts";
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";

const skip = process.env["AI_GATEWAY_API_KEY"] ? false : "AI_GATEWAY_API_KEY not set";

test("real gateway: one image generation", { skip }, async () => {
  const result = await VercelGateway.fromEnv().generateImage({
    model: "bfl/flux-3-image-klein",
    prompt: "a small red apple on a plain background",
    references: [],
    size: "768x768",
  });
  assert.ok(result.images.length >= 1);
  assert.ok(result.images.every((i) => i.mediaType.startsWith("image/") && i.bytes.length > 0));
  // The gateway's own request ID and cost reach provenance; a locally generated ID would not count.
  assert.equal(result.requestIdSource, "provider", `request ID ${result.requestId}`);
  assert.ok(!result.requestId.startsWith("local-"));
  assert.equal(typeof result.costUsd, "number", "the gateway reports the call's cost");
});

test("real gateway: one vision call", { skip }, async () => {
  const raster = createRaster(8, 8);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) setPixel(raster, x, y, [200, 30, 30, 255]);
  const result = await VercelGateway.fromEnv().analyzeImages({
    model: "google/gemini-3-flash",
    prompt: "Describe this image in one short sentence.",
    images: [{ mediaType: "image/png", bytes: encodePng(raster) }],
  });
  assert.ok(result.text.trim().length > 0);
  assert.equal(result.requestIdSource, "provider", `request ID ${result.requestId}`);
  assert.ok(!result.requestId.startsWith("local-"));
  assert.equal(typeof result.costUsd, "number", "the gateway reports the call's cost");
});
