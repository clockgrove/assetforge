import type { Raster } from "../../src/image/raster.ts";

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitReader {
  private pos = 0;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new Error("WebP bitstream truncated");
      v |= ((byte >> (this.pos & 7)) & 1) << i;
      this.pos++;
    }
    return v >>> 0;
  }
}

interface Decoder {
  counts: number[];
  symbols: number[];
  single: number | undefined;
}

function buildDecoder(lengths: readonly number[]): Decoder {
  const counts = new Array<number>(16).fill(0);
  for (const l of lengths) counts[l] = (counts[l] ?? 0) + 1;
  const nonZero = lengths.map((l, s) => ({ l, s })).filter((e) => e.l > 0);
  if (nonZero.length === 1) return { counts, symbols: [], single: (nonZero[0] as { s: number }).s };
  let left = 1;
  for (let l = 1; l <= 15; l++) {
    left = left * 2 - (counts[l] ?? 0);
    if (left < 0) throw new Error("Over-subscribed prefix code");
  }
  if (left !== 0) throw new Error("Incomplete prefix code");
  const symbols = nonZero.sort((a, b) => a.l - b.l || a.s - b.s).map((e) => e.s);
  return { counts, symbols, single: undefined };
}

function decodeSymbol(br: BitReader, d: Decoder): number {
  if (d.single !== undefined) return d.single;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let l = 1; l <= 15; l++) {
    code |= br.read(1);
    const count = d.counts[l] ?? 0;
    if (code - count < first) return d.symbols[index + (code - first)] as number;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("Invalid prefix code in stream");
}

function readPrefixCode(br: BitReader, alphabetSize: number): Decoder {
  const lengths = new Array<number>(alphabetSize).fill(0);
  if (br.read(1) === 1) {
    const numSymbols = br.read(1) + 1;
    const first = br.read(1) === 1 ? br.read(8) : br.read(1);
    lengths[first] = 1;
    if (numSymbols === 2) lengths[br.read(8)] = 1;
    return buildDecoder(lengths);
  }
  const clLengths = new Array<number>(19).fill(0);
  const numCodeLengths = br.read(4) + 4;
  for (let i = 0; i < numCodeLengths; i++) clLengths[CODE_LENGTH_ORDER[i] as number] = br.read(3);
  const cl = buildDecoder(clLengths);
  let maxSymbol = alphabetSize;
  if (br.read(1) === 1) {
    const nbits = 2 + 2 * br.read(3);
    maxSymbol = 2 + br.read(nbits);
  }
  let prev = 8;
  let symbol = 0;
  while (symbol < alphabetSize) {
    if (maxSymbol-- === 0) break;
    const c = decodeSymbol(br, cl);
    if (c < 16) {
      lengths[symbol++] = c;
      if (c !== 0) prev = c;
      continue;
    }
    const repeat = c === 16 ? 3 + br.read(2) : c === 17 ? 3 + br.read(3) : 11 + br.read(7);
    const value = c === 16 ? prev : 0;
    if (symbol + repeat > alphabetSize) throw new Error("Code length repeat overruns alphabet");
    for (let i = 0; i < repeat; i++) lengths[symbol++] = value;
  }
  return buildDecoder(lengths);
}

/** Test-only decoder for the subset of VP8L the encoder emits: literals, no transforms or cache. */
export function decodeWebpLossless(bytes: Uint8Array): Raster {
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  const u32 = (o: number) =>
    ((bytes[o] ?? 0) |
      ((bytes[o + 1] ?? 0) << 8) |
      ((bytes[o + 2] ?? 0) << 16) |
      ((bytes[o + 3] ?? 0) << 24)) >>>
    0;
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP" || tag(12) !== "VP8L") {
    throw new Error("Not a simple lossless WebP file");
  }
  if (u32(4) + 8 !== bytes.length) throw new Error("RIFF size mismatch");
  const size = u32(16);
  const br = new BitReader(bytes.subarray(20, 20 + size));
  if (br.read(8) !== 0x2f) throw new Error("Bad VP8L signature");
  const width = br.read(14) + 1;
  const height = br.read(14) + 1;
  br.read(1);
  if (br.read(3) !== 0) throw new Error("Unsupported VP8L version");
  if (br.read(1) !== 0) throw new Error("Transforms unsupported");
  if (br.read(1) !== 0) throw new Error("Colour cache unsupported");
  if (br.read(1) !== 0) throw new Error("Meta prefix codes unsupported");
  const green = readPrefixCode(br, 256 + 24);
  const red = readPrefixCode(br, 256);
  const blue = readPrefixCode(br, 256);
  const alpha = readPrefixCode(br, 256);
  readPrefixCode(br, 40);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const g = decodeSymbol(br, green);
    if (g >= 256) throw new Error("Backward references unsupported");
    data[i] = decodeSymbol(br, red);
    data[i + 1] = g;
    data[i + 2] = decodeSymbol(br, blue);
    data[i + 3] = decodeSymbol(br, alpha);
  }
  return { width, height, data };
}
