// `sha256Hex` from Clockgrove's packages/assets/src/validate.ts, at the commit in ./README.md.
import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
