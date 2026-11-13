/**
 * A scripted 3D provider for shared-rig runs: every model call answers with a synthetic
 * plantigrade quadruped facing +x, as Tripo's do
 * (test/fixtures/quadruped.ts). A target that declares a rig template makes
 * no rig or clip call, so those throw.
 */
import type { Script } from "../../src/gateway/scripted.ts";
import { syntheticQuadruped } from "./quadruped.ts";

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
      glb: syntheticQuadruped({
        raisedHeels: index % 2 === 1,
        providerRig: true,
        facing: "+x",
        // Look-dev tests need a real unwrap, so masks on the head hold their own texels.
        atlasUvs: process.env["SCRIPT_QUADRUPED_ATLAS"] === "1",
        // A provider's own asset extras, which a staged model must not carry.
        ...(process.env["SCRIPT_QUADRUPED_EXTRAS"] === "1" && {
          assetExtras: { provider: { task: `model-${index}` } },
        }),
      }),
      costUsd: 0.3,
      ...(request.seed !== undefined && { seed: request.seed }),
    };
  },
  rig() {
    throw new Error("a shared-rig target makes no rig call");
  },
  animate() {
    throw new Error("a shared-rig target makes no clip call");
  },
};

export default script;
