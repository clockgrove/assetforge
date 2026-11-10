/**
 * A scripted 3D provider for tests and offline runs: every model, rig and clip call answers with a
 * synthetic rigged character (test/fixtures/glb.ts). `SCRIPT_3D_TRIANGLES` makes every candidate
 * that many triangles (to exceed a budget); `SCRIPT_3D_OPEN_LOOP=1` leaves the clip unclosed by the
 * provider (Assetforge closes it).
 */
import type { Script } from "../../src/gateway/scripted.ts";
import { syntheticCharacter } from "./glb.ts";

const triangles = Number(process.env["SCRIPT_3D_TRIANGLES"] ?? 300);

const script: Script = {
  image() {
    throw new Error("the 3D script makes no images");
  },
  vision() {
    throw new Error("the 3D script answers no vision calls");
  },
  decide(_request, index) {
    return {
      answer: { type: "score", score: index % 2 === 0 ? 3.6 : 2.2 },
      confidence: 0.7,
      costUsd: 0.00002,
    };
  },
  model(request, index) {
    return {
      handle: `model-${index}`,
      glb: syntheticCharacter({ triangles }),
      costUsd: 0.3,
      ...(request.seed !== undefined && { seed: request.seed }),
    };
  },
  rig(_request, index) {
    return {
      handle: `rig-${index}`,
      glb: syntheticCharacter({ triangles, joints: 3 }),
      costUsd: 0.25,
    };
  },
  animate(request, index) {
    return {
      handle: `clips-${index}`,
      glb: syntheticCharacter({
        triangles,
        joints: 3,
        clips: request.clips.map((clip) => ({
          name: clip,
          durationS: 1.5,
          loopClosed: process.env["SCRIPT_3D_OPEN_LOOP"] !== "1",
        })),
      }),
      costUsd: 0.1,
    };
  },
};

export default script;
