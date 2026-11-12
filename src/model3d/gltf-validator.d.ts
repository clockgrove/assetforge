/** The parts of the Khronos glTF validator (`gltf-validator`, which ships no types) Assetforge uses. */
declare module "gltf-validator" {
  export interface ValidationMessage {
    code: string;
    message: string;
    severity: number;
    pointer?: string;
    offset?: number;
  }
  export interface ValidationReport {
    validatorVersion?: string;
    issues: {
      numErrors: number;
      numWarnings: number;
      numInfos?: number;
      numHints?: number;
      messages: ValidationMessage[];
      truncated?: boolean;
    };
    [key: string]: unknown;
  }
  export function validateBytes(
    data: Uint8Array,
    options?: {
      uri?: string;
      format?: "glb" | "gltf";
      maxIssues?: number;
      externalResourceFunction?: (uri: string) => Promise<Uint8Array>;
    },
  ): Promise<ValidationReport>;
  export function version(): string;
  const validator: { validateBytes: typeof validateBytes; version: typeof version };
  export default validator;
}
