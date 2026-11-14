/**
 * A dense, textured, optionally rigged ellipsoid for the detail-level chain (assetgrove#136): a UV
 * sphere with a UV seam and per-pole vertices, one scene root, a 256 px checker base colour
 * embedded in the file and, optionally, a look-dev-style external side image by `uri`.
 */
import { createRaster, encodePng, setPixel } from "../../src/image/raster.ts";
import { writeGlb } from "../../src/model3d/glb.ts";
import type { GltfDocument } from "../../src/model3d/glb.ts";
import { Buffer3d, FLOAT, UINT, floats, minMax } from "./quadruped.ts";

export interface LodModelOptions {
  /** Latitude and longitude bands; the triangle count is 2 × lat × lon − 2 × lon. */
  lat?: number;
  lon?: number;
  /** Two joints, weights along the height, and the clips `idle` (looping) and `wave`. */
  rigged?: boolean;
  texturePx?: number;
  /** An image the file references by `uri`, recorded as look-dev's `groom.length` field. */
  external?: { uri: string };
}

/** Rounded so coincident seam and pole vertices are bit-identical, as an exporter writes them. */
const exact = (x: number) => Math.round(x * 1e6) / 1e6 || 0;

/** A checker with a gradient, `px` square. */
export function checkerPng(px: number): Uint8Array {
  const raster = createRaster(px, px);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const on = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0;
      setPixel(
        raster,
        x,
        y,
        on
          ? [230, Math.round((y / px) * 255), 60, 255]
          : [60, 120, Math.round((x / px) * 255), 255],
      );
    }
  }
  return encodePng(raster);
}

export function lodModel(options: LodModelOptions = {}): Uint8Array {
  const lat = options.lat ?? 36;
  const lon = options.lon ?? 56;
  const rigged = options.rigged === true;
  const buf = new Buffer3d();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i <= lat; i++) {
    const phi = (Math.PI * i) / lat;
    for (let j = 0; j <= lon; j++) {
      const theta = (2 * Math.PI * j) / lon;
      const n = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ].map(exact);
      const y = n[1]! * 0.5 + 0.5;
      positions.push(n[0]! * 0.5, y, n[2]! * 0.35);
      normals.push(...n);
      uvs.push(j / lon, i / lat);
      joints.push(0, 1, 0, 0);
      weights.push(1 - y, y, 0, 0);
    }
  }
  const indices: number[] = [];
  const row = lon + 1;
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      if (i > 0) indices.push(a, c, b);
      if (i < lat - 1) indices.push(b, c, d);
    }
  }
  const count = positions.length / 3;
  const vec = (values: number[], type: string, extra = {}) =>
    buf.accessor(floats(values), { componentType: FLOAT, count, type, target: 34962, ...extra });
  const attributes: Record<string, number> = {
    POSITION: vec(positions, "VEC3", minMax(positions, 3)),
    NORMAL: vec(normals, "VEC3"),
    TEXCOORD_0: vec(uvs, "VEC2"),
  };
  if (rigged) {
    attributes["JOINTS_0"] = buf.accessor(Uint8Array.from(joints), {
      componentType: 5121,
      count,
      type: "VEC4",
      target: 34962,
    });
    attributes["WEIGHTS_0"] = vec(weights, "VEC4");
  }
  const index = buf.accessor(new Uint8Array(Uint32Array.from(indices).buffer), {
    componentType: UINT,
    count: indices.length,
    type: "SCALAR",
    target: 34963,
  });
  const image = buf.view(checkerPng(options.texturePx ?? 256));

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const raised = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1];
  const json: GltfDocument = {
    asset: { version: "2.0", generator: "assetgrove-test-fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: rigged
      ? [
          { name: "kit", children: [1, 2] },
          { name: "body", mesh: 0, skin: 0 },
          { name: "hips", children: [3] },
          { name: "spine", translation: [0, 0.5, 0] },
        ]
      : [{ name: "body", mesh: 0 }],
    meshes: [{ name: "body", primitives: [{ attributes, indices: index, material: 0, mode: 4 }] }],
    materials: [
      {
        name: "skin",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          baseColorTexture: { index: 0 },
        },
      },
    ],
    textures: [{ source: 0 }],
    images: [{ bufferView: image, mimeType: "image/png" }],
    accessors: buf.accessors,
    bufferViews: buf.bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  if (rigged) {
    const ibm = buf.accessor(floats([...identity, ...raised]), {
      componentType: FLOAT,
      count: 2,
      type: "MAT4",
    });
    json.skins = [{ joints: [2, 3], inverseBindMatrices: ibm, skeleton: 2 }];
    const clip = (name: string, loop: boolean, peak: number) => {
      const times = buf.accessor(floats([0, 0.5, 1]), {
        componentType: FLOAT,
        count: 3,
        type: "SCALAR",
        min: [0],
        max: [1],
      });
      const q = [0, 0.5, 1].map((t) => {
        const a = peak * Math.sin(Math.PI * t);
        return [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
      });
      const output = buf.accessor(floats(q.flat()), {
        componentType: FLOAT,
        count: 3,
        type: "VEC4",
      });
      return {
        name,
        samplers: [{ input: times, output, interpolation: "LINEAR" }],
        channels: [{ sampler: 0, target: { node: 3, path: "rotation" } }],
        extras: { loop },
      };
    };
    json.animations = [clip("idle", true, 0.2), clip("wave", false, 0.4)];
  }
  if (options.external) {
    json.images!.push({ uri: options.external.uri });
    json.asset.extras = {
      lookdev: { images: { "groom.length": { image: 1, uri: options.external.uri } } },
    };
  }
  json.buffers = [{ byteLength: buf.length }];
  return writeGlb({ json, bin: buf.bin() });
}
