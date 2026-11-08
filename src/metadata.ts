import { userInfo } from "node:os";
import { InputError } from "./errors.ts";
import { inflateSync } from "node:zlib";
import type { TransformStep } from "./transform/types.ts";

const vocabulary = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const namespace = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/";
export const DIGITAL_SOURCE_TYPES = {
  generated: `${vocabulary}trainedAlgorithmicMedia`,
  composite: `${vocabulary}compositeWithTrainedAlgorithmicMedia`,
  human: `${vocabulary}digitalCreation`,
  undeclared: "undeclared",
} as const;
// IPTC Digital Source Type vocabulary, including retained deprecated concepts.
const sourceCodes = [
  "digitalCapture",
  "computationalCapture",
  "negativeFilm",
  "positiveFilm",
  "print",
  "minorHumanEdits",
  "humanEdits",
  "compositeWithTrainedAlgorithmicMedia",
  "algorithmicallyEnhanced",
  "softwareImage",
  "digitalArt",
  "digitalCreation",
  "dataDrivenMedia",
  "trainedAlgorithmicMedia",
  "algorithmicMedia",
  "screenCapture",
  "virtualRecording",
  "composite",
  "compositeCapture",
  "compositeSynthetic",
] as const;
export type IptcDigitalSourceType = `${typeof vocabulary}${(typeof sourceCodes)[number]}`;
export type DigitalSourceType = IptcDigitalSourceType | "undeclared";
export interface SourceDeclaration {
  value: IptcDigitalSourceType;
  declaredBy: string;
}

export function parseDigitalSourceType(value: string): IptcDigitalSourceType | undefined {
  const code = sourceCodes.find((code) => value === code || value === `${vocabulary}${code}`);
  return code === undefined ? undefined : `${vocabulary}${code}`;
}
function sourceType(value: unknown): IptcDigitalSourceType | undefined {
  return typeof value === "string" ? parseDigitalSourceType(value) : undefined;
}
export function sourceDeclaration(value: DigitalSourceType): SourceDeclaration {
  const parsed = parseDigitalSourceType(value);
  if (!parsed) throw new InputError(`invalid --digital-source-type: ${value}`);
  return { value: parsed, declaredBy: userInfo().username };
}
export function requireDeclared(value: DigitalSourceType | undefined): void {
  if (!value || value === "undeclared")
    throw new InputError(
      "refused: asset source type is undeclared; declare it with --digital-source-type <IPTC code> before publishing or exporting",
    );
}
export function combineDigitalSourceTypes(values: readonly DigitalSourceType[]): DigitalSourceType {
  if (values.includes(DIGITAL_SOURCE_TYPES.composite)) return DIGITAL_SOURCE_TYPES.composite;
  if (values.includes(DIGITAL_SOURCE_TYPES.generated))
    return values.some((value) => value !== DIGITAL_SOURCE_TYPES.generated)
      ? DIGITAL_SOURCE_TYPES.composite
      : DIGITAL_SOURCE_TYPES.generated;
  if (!values.length || values.includes("undeclared")) return "undeclared";
  return values[0]!;
}

export function metadataStep(value: DigitalSourceType, pixelHashes: string[]): TransformStep {
  return {
    op: "embed-digital-source-type",
    params: { digitalSourceType: value },
    engine: { name: "assetforge-xmp", version: "1" },
    inputs: [...pixelHashes],
    outputs: [...pixelHashes],
  };
}

function xmp(value: DigitalSourceType, previous?: string): string {
  const description = `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${namespace}"><Iptc4xmpExt:DigitalSourceType>${value}</Iptc4xmpExt:DigitalSourceType></rdf:Description>`;
  if (previous) {
    if (readXmp(previous) === value) return previous;
    // Keep other XMP properties, including those in the same RDF description.
    const clean = previous;
    const prefixes = [
      ...previous.matchAll(
        /xmlns:([\w.-]+)\s*=\s*["']http:\/\/iptc.org\/std\/Iptc4xmpExt\/2008-02-29\/["']/g,
      ),
    ].map((m) => m[1]!);
    for (const prefix of prefixes) {
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const element = new RegExp(
        `<${escaped}:DigitalSourceType\\b[^>]*(?:/>|>[\\s\\S]*?<\\/${escaped}:DigitalSourceType\\s*>)`,
      );
      if (element.test(clean))
        return clean.replace(
          element,
          `<${prefix}:DigitalSourceType>${value}</${prefix}:DigitalSourceType>`,
        );
      const attribute = new RegExp(`(${escaped}:DigitalSourceType\\s*=\\s*)(["'])[\\s\\S]*?\\2`);
      if (attribute.test(clean)) return clean.replace(attribute, `$1"${value}"`);
    }
    const emptyRdf = /<([\w.-]+):RDF\b([^>]*?)\/>/.exec(clean);
    if (emptyRdf)
      return clean.replace(
        emptyRdf[0],
        `<${emptyRdf[1]}:RDF${emptyRdf[2]}>${description.replaceAll("rdf:", `${emptyRdf[1]}:`)}</${emptyRdf[1]}:RDF>`,
      );
    const rdf = /<\/([\w.-]+):RDF\s*>/.exec(clean);
    if (rdf) {
      const prefix = rdf[1]!;
      return clean.replace(rdf[0], description.replaceAll("rdf:", `${prefix}:`) + rdf[0]);
    }
    throw new Error("cannot preserve XMP without an RDF container");
  }
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${description}</rdf:RDF></x:xmpmeta>`;
}

function readXmp(xml: string): DigitalSourceType | undefined {
  const prefixes = [
    ...xml.matchAll(
      /xmlns:([\w.-]+)\s*=\s*["']http:\/\/iptc.org\/std\/Iptc4xmpExt\/2008-02-29\/["']/g,
    ),
  ].map((m) => m[1]!);
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const element = new RegExp(
      `<${escaped}:DigitalSourceType\\b[^>]*>([\\s\\S]*?)<\\/${escaped}:DigitalSourceType\\s*>`,
    ).exec(xml);
    const resource = new RegExp(
      `<${escaped}:DigitalSourceType\\b[^>]*\\brdf:resource=["']([^"']+)["']`,
    ).exec(xml);
    const attribute = new RegExp(`${escaped}:DigitalSourceType\\s*=\\s*["']([^"']+)["']`).exec(xml);
    const value = sourceType(resource?.[1] ?? element?.[1]?.trim() ?? attribute?.[1]);
    if (value) return value;
  }
  return undefined;
}

interface Chunk {
  type: string;
  data: Buffer;
}
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngChunks(bytes: Uint8Array): Chunk[] {
  const b = Buffer.from(bytes);
  if (!b.subarray(0, 8).equals(pngSignature)) throw new Error("invalid PNG signature");
  const chunks: Chunk[] = [];
  for (let offset = 8; offset < b.length;) {
    if (offset + 12 > b.length) throw new Error("truncated PNG chunk");
    const length = b.readUInt32BE(offset);
    if (offset + length + 12 > b.length) throw new Error("truncated PNG chunk");
    chunks.push({
      type: b.toString("ascii", offset + 4, offset + 8),
      data: b.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return chunks;
}
function pngXmp(chunk: Chunk): string | undefined {
  if (chunk.type !== "iTXt") return undefined;
  const keywordEnd = chunk.data.indexOf(0);
  if (chunk.data.toString("ascii", 0, keywordEnd) !== "XML:com.adobe.xmp") return undefined;
  const compressed = chunk.data[keywordEnd + 1];
  const languageEnd = chunk.data.indexOf(0, keywordEnd + 3);
  const translatedEnd = chunk.data.indexOf(0, languageEnd + 1);
  if (languageEnd < 0 || translatedEnd < 0) throw new Error("invalid PNG XMP iTXt");
  const data = chunk.data.subarray(translatedEnd + 1);
  return (compressed === 1 ? inflateSync(data) : data).toString("utf8");
}
function readJpegSourceType(bytes: Uint8Array): DigitalSourceType | undefined {
  const b = Buffer.from(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("invalid JPEG signature");
  const identifier = Buffer.from("http://ns.adobe.com/xap/1.0/\0");
  let offset = 2;
  while (offset < b.length) {
    if (b[offset++] !== 0xff) throw new Error("invalid JPEG marker");
    while (b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (marker === undefined) throw new Error("truncated JPEG marker");
    // XMP belongs to the header; entropy-coded scan data is not a segment stream.
    if (marker === 0xda || marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > b.length) throw new Error("truncated JPEG segment");
    const length = b.readUInt16BE(offset);
    if (length < 2 || offset + length > b.length) throw new Error("invalid JPEG segment length");
    const data = b.subarray(offset + 2, offset + length);
    if (marker === 0xe1 && data.subarray(0, identifier.length).equals(identifier)) {
      const value = readXmp(data.subarray(identifier.length).toString("utf8"));
      if (value) return value;
    }
    offset += length;
  }
  return undefined;
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function encodePngChunk(chunk: Chunk): Buffer {
  const b = Buffer.alloc(chunk.data.length + 12);
  b.writeUInt32BE(chunk.data.length);
  b.write(chunk.type, 4, 4, "ascii");
  chunk.data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, b.length - 4)), b.length - 4);
  return b;
}
function webpChunks(bytes: Uint8Array): Chunk[] {
  const b = Buffer.from(bytes);
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WEBP" ||
    b.readUInt32LE(4) + 8 !== b.length
  )
    throw new Error("invalid WebP container");
  const chunks: Chunk[] = [];
  for (let offset = 12; offset < b.length;) {
    if (offset + 8 > b.length) throw new Error("truncated WebP chunk");
    const length = b.readUInt32LE(offset + 4);
    if (offset + 8 + length + (length & 1) > b.length) throw new Error("truncated WebP chunk");
    chunks.push({
      type: b.toString("ascii", offset, offset + 4),
      data: b.subarray(offset + 8, offset + 8 + length),
    });
    offset += 8 + length + (length & 1);
  }
  return chunks;
}
function encodeWebpChunk(chunk: Chunk): Buffer {
  const b = Buffer.alloc(8 + chunk.data.length + (chunk.data.length & 1));
  b.write(chunk.type, 0, 4, "ascii");
  b.writeUInt32LE(chunk.data.length, 4);
  chunk.data.copy(b, 8);
  return b;
}
function webpHeader(chunks: Chunk[]): Chunk {
  const existing = chunks.find((c) => c.type === "VP8X");
  if (existing) {
    const data = Buffer.from(existing.data);
    data[0] = data[0]! | 4;
    return { type: "VP8X", data };
  }
  const lossless = chunks.find((c) => c.type === "VP8L");
  const lossy = chunks.find((c) => c.type === "VP8 ");
  let width: number, height: number, alpha: boolean;
  if (lossless) {
    const bits = lossless.data.readUInt32LE(1);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
    alpha = (bits & 0x10000000) !== 0;
  } else if (lossy) {
    width = lossy.data.readUInt16LE(6) & 0x3fff;
    height = lossy.data.readUInt16LE(8) & 0x3fff;
    alpha = chunks.some((c) => c.type === "ALPH");
  } else throw new Error("WebP has no image dimensions");
  const data = Buffer.alloc(10);
  data[0] = 4 | (alpha ? 16 : 0);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return { type: "VP8X", data };
}

type Gltf = {
  asset?: { extensions?: Record<string, unknown>; [key: string]: unknown };
  extensions?: Record<string, unknown>;
  extensionsUsed?: string[];
  [key: string]: unknown;
};
/** Adds a document-level packet while preserving other extensions and packet references. */
export function embedGltfDigitalSourceType(document: Gltf, value: DigitalSourceType): Gltf {
  const result = structuredClone(document);
  if (value === "undeclared") return result;
  const extensions = (result.extensions ??= {});
  const old = extensions["KHR_xmp_json_ld"] as
    { packets?: Record<string, unknown>[]; packet?: number } | undefined;
  const packets = structuredClone(old?.packets ?? []);
  const asset = (result.asset ??= { version: "2.0" });
  const assetExtensions = (asset.extensions ??= {});
  const reference = assetExtensions["KHR_xmp_json_ld"] as { packet?: number } | undefined;
  let index = reference?.packet ?? packets.length;
  const shared = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(shared);
    const object = value as Record<string, unknown>;
    const binding = (object["extensions"] as Record<string, unknown> | undefined)?.[
      "KHR_xmp_json_ld"
    ] as { packet?: number } | undefined;
    return binding?.packet === index || Object.values(object).some(shared);
  };
  if (
    reference &&
    Object.entries(result).some(
      ([key, value]) => key !== "asset" && key !== "extensions" && shared(value),
    )
  ) {
    packets.push(structuredClone(packets[index] ?? {}));
    index = packets.length - 1;
  }
  const packet = packets[index] ?? {};
  packet["@id"] ??= "";
  packet["@context"] = { ...((packet["@context"] as object) ?? {}), Iptc4xmpExt: namespace };
  packet["Iptc4xmpExt:DigitalSourceType"] = value;
  packets[index] = packet;
  extensions["KHR_xmp_json_ld"] = { ...old, packets };
  assetExtensions["KHR_xmp_json_ld"] = { ...reference, packet: index };
  result.extensionsUsed = [...new Set([...(result.extensionsUsed ?? []), "KHR_xmp_json_ld"])];
  return result;
}

export function embedDigitalSourceType(
  bytes: Uint8Array,
  mediaType: string,
  value: DigitalSourceType,
): Uint8Array {
  if (value === "undeclared") return bytes;
  if (mediaType === "image/png") {
    const chunks = pngChunks(bytes);
    const previous = chunks.map(pngXmp).find((s) => s !== undefined);
    const metadata: Chunk = {
      type: "iTXt",
      data: Buffer.concat([
        Buffer.from("XML:com.adobe.xmp\0\0\0\0\0"),
        Buffer.from(xmp(value, previous)),
      ]),
    };
    const filtered = chunks.filter((c) => pngXmp(c) === undefined);
    const end = filtered.findIndex((c) => c.type === "IEND");
    if (end < 0) throw new Error("PNG has no IEND");
    const imageData = filtered.findIndex((c) => c.type === "IDAT");
    filtered.splice(imageData < 0 ? end : imageData, 0, metadata);
    return Buffer.concat([pngSignature, ...filtered.map(encodePngChunk)]);
  }
  if (mediaType === "image/webp") {
    const chunks = webpChunks(bytes);
    const previous = chunks.find((c) => c.type === "XMP ")?.data.toString("utf8");
    const payload = Buffer.concat([
      Buffer.from("WEBP"),
      ...[
        webpHeader(chunks),
        ...chunks.filter((c) => !["XMP ", "VP8X"].includes(c.type)),
        { type: "XMP ", data: Buffer.from(xmp(value, previous)) },
      ].map(encodeWebpChunk),
    ]);
    const header = Buffer.alloc(8);
    header.write("RIFF");
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }
  if (mediaType === "model/gltf+json")
    return Buffer.from(
      `${JSON.stringify(embedGltfDigitalSourceType(JSON.parse(Buffer.from(bytes).toString("utf8")) as Gltf, value))}\n`,
    );
  return bytes;
}

export function readDigitalSourceType(
  bytes: Uint8Array,
  mediaType: string,
): DigitalSourceType | undefined {
  if (mediaType === "image/png") {
    for (const chunk of pngChunks(bytes)) {
      const xml = pngXmp(chunk);
      const value = xml === undefined ? undefined : readXmp(xml);
      if (value) return value;
    }
  } else if (mediaType === "image/jpeg") {
    return readJpegSourceType(bytes);
  } else if (mediaType === "image/webp") {
    const xml = webpChunks(bytes)
      .find((c) => c.type === "XMP ")
      ?.data.toString("utf8");
    if (xml !== undefined) return readXmp(xml);
  } else if (mediaType === "model/gltf+json") {
    const doc = JSON.parse(Buffer.from(bytes).toString("utf8")) as Gltf;
    const ext = doc.extensions?.["KHR_xmp_json_ld"] as
      { packet?: number; packets?: Record<string, unknown>[] } | undefined;
    const reference = doc.asset?.extensions?.["KHR_xmp_json_ld"] as { packet?: number } | undefined;
    if (reference?.packet === undefined) return undefined;
    return sourceType(ext?.packets?.[reference.packet]?.["Iptc4xmpExt:DigitalSourceType"]);
  }
  return undefined;
}
