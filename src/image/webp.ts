import type { Raster } from "./raster.ts";

const MAX_DIMENSION = 16384;
const MAX_CODE_LENGTH = 15;
const CODE_LENGTH_CODE_LIMIT = 7;
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private count = 0;

  /** Writes the low `n` bits of `value`, least significant bit first. */
  write(value: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.acc |= ((value >>> i) & 1) << this.count;
      this.count++;
      if (this.count === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.count = 0;
      }
    }
  }

  finish(): number[] {
    if (this.count > 0) {
      this.bytes.push(this.acc);
      this.acc = 0;
      this.count = 0;
    }
    return this.bytes;
  }
}

/** Huffman code lengths for a histogram, limited to `limit`; unused symbols get length 0. */
function codeLengths(histogram: readonly number[], limit: number): number[] {
  const freqs = histogram.slice();
  for (;;) {
    const lengths = huffmanLengths(freqs);
    if (Math.max(0, ...lengths) <= limit) return lengths;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i] ?? 0;
      if (f > 0) freqs[i] = (f + 1) >> 1;
    }
  }
}

function huffmanLengths(freqs: readonly number[]): number[] {
  const lengths = new Array<number>(freqs.length).fill(0);
  const parent: number[] = [];
  const weight: number[] = [];
  let queue: number[] = [];
  freqs.forEach((f, symbol) => {
    if (f > 0) {
      parent[symbol] = -1;
      weight[symbol] = f;
      queue.push(symbol);
    }
  });
  if (queue.length === 0) return lengths;
  if (queue.length === 1) {
    lengths[queue[0] as number] = 1;
    return lengths;
  }
  let next = freqs.length;
  const byWeight = (a: number, b: number) => (weight[a] ?? 0) - (weight[b] ?? 0) || a - b;
  queue.sort(byWeight);
  while (queue.length > 1) {
    const a = queue[0] as number;
    const b = queue[1] as number;
    parent[next] = -1;
    weight[next] = (weight[a] ?? 0) + (weight[b] ?? 0);
    parent[a] = next;
    parent[b] = next;
    queue = queue.slice(2);
    queue.push(next);
    queue.sort(byWeight);
    next++;
  }
  for (let s = 0; s < freqs.length; s++) {
    if ((freqs[s] ?? 0) === 0) continue;
    let depth = 0;
    for (let n = s; (parent[n] ?? -1) !== -1; n = parent[n] as number) depth++;
    lengths[s] = depth;
  }
  return lengths;
}

/** Canonical codes, already bit-reversed so they can be written least significant bit first. */
function canonicalCodes(lengths: readonly number[]): number[] {
  const codes = new Array<number>(lengths.length).fill(0);
  const counts = new Array<number>(MAX_CODE_LENGTH + 2).fill(0);
  for (const l of lengths) if (l > 0) counts[l] = (counts[l] ?? 0) + 1;
  const nextCode = new Array<number>(MAX_CODE_LENGTH + 2).fill(0);
  let code = 0;
  for (let l = 1; l <= MAX_CODE_LENGTH; l++) {
    code = (code + (counts[l - 1] ?? 0)) << 1;
    if (l === 1) code = 0;
    nextCode[l] = code;
  }
  lengths.forEach((l, symbol) => {
    if (l === 0) return;
    const c = nextCode[l] ?? 0;
    nextCode[l] = c + 1;
    let reversed = 0;
    for (let i = 0; i < l; i++) reversed |= ((c >>> i) & 1) << (l - 1 - i);
    codes[symbol] = reversed;
  });
  return codes;
}

interface PrefixCode {
  lengths: number[];
  codes: number[];
}

/** Writes one prefix code's description and returns how to emit its symbols. */
function writePrefixCode(w: BitWriter, histogram: readonly number[]): PrefixCode {
  const used: number[] = [];
  histogram.forEach((f, s) => {
    if (f > 0) used.push(s);
  });
  if (used.length <= 1) {
    const symbol = used[0] ?? 0;
    w.write(1, 1);
    w.write(0, 1);
    if (symbol < 2) {
      w.write(0, 1);
      w.write(symbol, 1);
    } else {
      w.write(1, 1);
      w.write(symbol, 8);
    }
    const lengths = new Array<number>(histogram.length).fill(0);
    return { lengths, codes: lengths.slice() };
  }

  const lengths = codeLengths(histogram, MAX_CODE_LENGTH);
  const tokens: { symbol: number; extra: number; extraBits: number }[] = [];
  for (let i = 0; i < lengths.length;) {
    const l = lengths[i] ?? 0;
    if (l !== 0) {
      tokens.push({ symbol: l, extra: 0, extraBits: 0 });
      i++;
      continue;
    }
    let run = 0;
    while (i + run < lengths.length && lengths[i + run] === 0) run++;
    i += run;
    while (run >= 11) {
      const n = Math.min(run, 138);
      tokens.push({ symbol: 18, extra: n - 11, extraBits: 7 });
      run -= n;
    }
    if (run >= 3) {
      tokens.push({ symbol: 17, extra: run - 3, extraBits: 3 });
      run = 0;
    }
    for (; run > 0; run--) tokens.push({ symbol: 0, extra: 0, extraBits: 0 });
  }

  const tokenHistogram = new Array<number>(19).fill(0);
  for (const t of tokens) tokenHistogram[t.symbol] = (tokenHistogram[t.symbol] ?? 0) + 1;
  const tokenLengths = codeLengths(tokenHistogram, CODE_LENGTH_CODE_LIMIT);
  const tokenCodes = canonicalCodes(tokenLengths);
  const singleToken = tokenLengths.filter((l) => l > 0).length === 1;

  let numCodeLengths = 19;
  while (
    numCodeLengths > 4 &&
    (tokenLengths[CODE_LENGTH_ORDER[numCodeLengths - 1] as number] ?? 0) === 0
  ) {
    numCodeLengths--;
  }
  w.write(0, 1);
  w.write(numCodeLengths - 4, 4);
  for (let i = 0; i < numCodeLengths; i++) {
    w.write(tokenLengths[CODE_LENGTH_ORDER[i] as number] ?? 0, 3);
  }
  w.write(0, 1);
  for (const t of tokens) {
    if (!singleToken) w.write(tokenCodes[t.symbol] ?? 0, tokenLengths[t.symbol] ?? 0);
    w.write(t.extra, t.extraBits);
  }
  return { lengths, codes: canonicalCodes(lengths) };
}

function put(w: BitWriter, p: PrefixCode, symbol: number): void {
  const l = p.lengths[symbol] ?? 0;
  if (l > 0) w.write(p.codes[symbol] ?? 0, l);
}

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/**
 * Encodes a raster as a lossless WebP (simple file format, one VP8L chunk): no transforms, no
 * colour cache, one prefix-code group, literals only. The output is a pure function of the input.
 */
export function encodeWebpLossless(r: Raster): Uint8Array {
  const { width, height, data } = r;
  for (const d of [width, height]) {
    if (!Number.isInteger(d) || d < 1 || d > MAX_DIMENSION) {
      throw new Error(`WebP dimensions must be 1..${MAX_DIMENSION}, got ${width}x${height}`);
    }
  }
  if (data.length !== width * height * 4) {
    throw new Error("Raster data length does not match its dimensions");
  }

  const green = new Array<number>(256 + 24).fill(0);
  const red = new Array<number>(256).fill(0);
  const blue = new Array<number>(256).fill(0);
  const alpha = new Array<number>(256).fill(0);
  let alphaUsed = false;
  for (let i = 0; i < data.length; i += 4) {
    const rr = data[i] as number;
    const gg = data[i + 1] as number;
    const bb = data[i + 2] as number;
    const aa = data[i + 3] as number;
    red[rr]!++;
    green[gg]!++;
    blue[bb]!++;
    alpha[aa]!++;
    if (aa !== 255) alphaUsed = true;
  }

  const w = new BitWriter();
  w.write(0x2f, 8);
  w.write(width - 1, 14);
  w.write(height - 1, 14);
  w.write(alphaUsed ? 1 : 0, 1);
  w.write(0, 3);
  w.write(0, 1); // no transform
  w.write(0, 1); // no colour cache
  w.write(0, 1); // no meta prefix codes
  const pg = writePrefixCode(w, green);
  const pr = writePrefixCode(w, red);
  const pb = writePrefixCode(w, blue);
  const pa = writePrefixCode(w, alpha);
  writePrefixCode(w, []); // distance code, never used
  for (let i = 0; i < data.length; i += 4) {
    put(w, pg, data[i + 1] as number);
    put(w, pr, data[i] as number);
    put(w, pb, data[i + 2] as number);
    put(w, pa, data[i + 3] as number);
  }
  const payload = w.finish();

  const pad = payload.length % 2;
  const riffSize = 4 + 8 + payload.length + pad;
  const out = new Uint8Array(8 + riffSize);
  out.set([0x52, 0x49, 0x46, 0x46, ...u32le(riffSize), 0x57, 0x45, 0x42, 0x50], 0);
  out.set([0x56, 0x50, 0x38, 0x4c, ...u32le(payload.length)], 12);
  out.set(payload, 20);
  return out;
}

function u24le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
}

function chunk(tag: string, payload: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(8 + payload.length + (payload.length % 2));
  out.set([...Array.from(tag, (c) => c.charCodeAt(0)), ...u32le(payload.length)], 0);
  out.set(payload, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Encodes same-sized rasters as an animated lossless WebP (extended file format: VP8X, ANIM, then
 * one ANMF per frame holding that frame's VP8L chunk). Frames are not blended; every frame lasts
 * `durationMs`. The output is a pure function of the input.
 */
export function encodeAnimatedWebp(
  frames: Raster[],
  options: {
    durationMs: number;
    /** 0 loops forever. */
    loopCount?: number;
    background?: [number, number, number, number];
  },
): Uint8Array {
  const first = frames[0];
  if (!first) throw new Error("An animated WebP needs at least one frame");
  const { width, height } = first;
  if (frames.some((f) => f.width !== width || f.height !== height)) {
    throw new Error("Animated WebP frames must all share one size");
  }
  const { durationMs, loopCount = 0, background = [0, 0, 0, 0] } = options;
  if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs >= 1 << 24) {
    throw new Error(`WebP frame duration must be 0..16777215 ms, got ${durationMs}`);
  }
  if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 0xffff) {
    throw new Error(`WebP loop count must be 0..65535, got ${loopCount}`);
  }
  const hasAlpha = frames.some((f) => {
    for (let i = 3; i < f.data.length; i += 4) if (f.data[i] !== 255) return true;
    return false;
  });

  const parts: Uint8Array[] = [
    Uint8Array.of(0x57, 0x45, 0x42, 0x50),
    chunk("VP8X", [
      0x02 | (hasAlpha ? 0x10 : 0),
      0,
      0,
      0,
      ...u24le(width - 1),
      ...u24le(height - 1),
    ]),
  ];
  const [br, bg, bb, ba] = background;
  parts.push(chunk("ANIM", [bb, bg, br, ba, loopCount & 0xff, loopCount >>> 8]));
  for (const frame of frames) {
    const header = [
      ...u24le(0),
      ...u24le(0),
      ...u24le(width - 1),
      ...u24le(height - 1),
      ...u24le(durationMs),
      0x02,
    ];
    parts.push(
      chunk("ANMF", concat([Uint8Array.from(header), encodeWebpLossless(frame).subarray(12)])),
    );
  }
  const body = concat(parts);
  return concat([Uint8Array.of(0x52, 0x49, 0x46, 0x46, ...u32le(body.length)), body]);
}
