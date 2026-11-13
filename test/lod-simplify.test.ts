import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGlb, readAccessor, writeGlb } from "../src/model3d/glb.ts";
import type { Glb } from "../src/model3d/glb.ts";
import { appendSimplifiedMesh, levelGlb, simplifyPrimitives } from "../src/model3d/lod/simplify.ts";
import { validatorCheck } from "../src/model3d/qa.ts";
import { measure } from "../src/model3d/scene.ts";
import { Buffer3d, FLOAT, UINT, floats, minMax } from "./fixtures/quadruped.ts";

const LAT = 40;
const LON = 64;
/** Rounded so coincident seam and pole vertices are bit-identical, as an exporter writes them. */
const exact = (x: number) => Math.round(x * 1e6) / 1e6 || 0;

/** A UV sphere with a UV seam (duplicated column) and per-pole vertices, skinned to two joints. */
function skinnedSphere(): Uint8Array {
  const buf = new Buffer3d();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i <= LAT; i++) {
    const phi = (Math.PI * i) / LAT;
    for (let j = 0; j <= LON; j++) {
      const theta = (2 * Math.PI * j) / LON;
      const n = [
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      ].map(exact);
      positions.push(n[0]! * 0.5, n[1]! * 0.5 + 0.5, n[2]! * 0.5);
      normals.push(...n);
      uvs.push(j / LON, i / LAT);
      const w = Math.min(1, Math.max(0, n[1]! * 0.5 + 0.5));
      joints.push(0, 1, 0, 0);
      weights.push(1 - w, w, 0, 0);
    }
  }
  const indices: number[] = [];
  const row = LON + 1;
  for (let i = 0; i < LAT; i++) {
    for (let j = 0; j < LON; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      if (i > 0) indices.push(a, c, b);
      if (i < LAT - 1) indices.push(b, c, d);
    }
  }
  const count = positions.length / 3;
  const vec = (values: number[], type: string, extra = {}) =>
    buf.accessor(floats(values), { componentType: FLOAT, count, type, target: 34962, ...extra });
  const position = vec(positions, "VEC3", minMax(positions, 3));
  const normal = vec(normals, "VEC3");
  const uv = vec(uvs, "VEC2");
  const weight = vec(weights, "VEC4");
  const joint = buf.accessor(Uint8Array.from(joints), {
    componentType: 5121,
    count,
    type: "VEC4",
    target: 34962,
  });
  const index = buf.accessor(new Uint8Array(Uint32Array.from(indices).buffer), {
    componentType: UINT,
    count: indices.length,
    type: "SCALAR",
    target: 34963,
  });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ibm = buf.accessor(floats([...identity, ...identity]), {
    componentType: FLOAT,
    count: 2,
    type: "MAT4",
  });
  const times = buf.accessor(floats([0, 1]), {
    componentType: FLOAT,
    count: 2,
    type: "SCALAR",
    min: [0],
    max: [1],
  });
  const rotations = buf.accessor(floats([0, 0, 0, 1, 0, 0, 0.3827, 0.9239]), {
    componentType: FLOAT,
    count: 2,
    type: "VEC4",
  });
  const json = {
    asset: { version: "2.0", extras: { keep: "me" } },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: "body", mesh: 0, skin: 0 },
      { name: "hips", children: [2] },
      { name: "spine", translation: [0, 0.5, 0] },
    ],
    meshes: [
      {
        name: "body",
        primitives: [
          {
            attributes: {
              POSITION: position,
              NORMAL: normal,
              TEXCOORD_0: uv,
              JOINTS_0: joint,
              WEIGHTS_0: weight,
            },
            indices: index,
            material: 0,
            extras: { tag: 1 },
          },
        ],
      },
    ],
    materials: [{ name: "skin", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
    skins: [{ joints: [1, 2], inverseBindMatrices: ibm, skeleton: 1 }],
    animations: [
      {
        name: "bend",
        samplers: [{ input: times, output: rotations }],
        channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }],
      },
    ],
    accessors: buf.accessors,
    bufferViews: buf.bufferViews,
    buffers: [{ byteLength: buf.length }],
  };
  return writeGlb({ json, bin: buf.bin() });
}

/** The rig and clips as JSON, accessor numbers aside (unused data is pruned, so they renumber). */
const without = (glb: Glb) => {
  const { skins, animations, nodes, materials, asset } = structuredClone(glb.json);
  for (const skin of skins ?? []) delete skin.inverseBindMatrices;
  for (const animation of animations ?? []) {
    for (const sampler of animation.samplers) {
      sampler.input = 0;
      sampler.output = 0;
    }
  }
  return { skins, animations, nodes, materials, asset };
};

const clipData = (glb: Glb) =>
  glb.json.animations!.flatMap((a) =>
    a.samplers.flatMap((s) => [...readAccessor(glb, s.input), ...readAccessor(glb, s.output)]),
  );

test("levels keep their triangle budget, attributes, rig and a valid file", async () => {
  const source = parseGlb(skinnedSphere());
  const full = measure(source).triangles;
  assert.ok(full > 4500);
  for (const ratio of [0.33, 0.1]) {
    const level = await levelGlb(source, ratio, 1);
    assert.ok(level.triangles <= Math.floor(ratio * full), `${ratio}: ${level.triangles}`);
    assert.ok(level.triangles > 0);
    const bytes = writeGlb(level.glb);
    const again = parseGlb(bytes);
    assert.equal(measure(again).triangles, level.triangles);
    assert.equal((await validatorCheck(bytes)).passed, true);
    assert.deepEqual(without(level.glb), without(source));
    assert.deepEqual(clipData(level.glb), clipData(source));
    assert.deepEqual(
      readAccessor(level.glb, level.glb.json.skins![0]!.inverseBindMatrices!),
      readAccessor(source, source.json.skins![0]!.inverseBindMatrices!),
    );
    assert.equal(level.glb.json.meshes!.length, 1);
    assert.equal(level.glb.json.meshes![0]!.name, "body_lod1");
    const primitive = level.glb.json.meshes![0]!.primitives[0]!;
    assert.deepEqual(primitive["extras"], { tag: 1 });
    assert.equal(primitive.material, 0);
    assert.ok(level.glb.bin.byteLength < source.bin.byteLength);

    const [kept] = level.primitives;
    const original = source.json.meshes![0]!.primitives[0]!;
    for (const name of ["POSITION", "NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"]) {
      const was = readAccessor(source, original.attributes[name]!);
      const now = readAccessor(level.glb, primitive.attributes[name]!);
      const width = was.length / (LAT + 1) / (LON + 1);
      assert.equal(now.length, kept!.vertexSources.length * width);
      kept!.vertexSources.forEach((from, v) => {
        assert.deepEqual(
          now.slice(v * width, (v + 1) * width),
          was.slice(from * width, (from + 1) * width),
        );
      });
    }
    const box = level.glb.json.accessors![primitive.attributes["POSITION"]!]!;
    const position = readAccessor(level.glb, primitive.attributes["POSITION"]!);
    assert.equal(box.min![1], Math.min(...position.filter((_, i) => i % 3 === 1)));
    assert.equal(box.max![1], Math.max(...position.filter((_, i) => i % 3 === 1)));

    // The surface stays closed where positions coincide: the UV seam and the poles do not tear.
    const key = (v: number) =>
      [0, 1, 2].map((c) => Math.round(position[v * 3 + c]! * 1e5) || 0).join(",");
    const edges = new Map<string, number>();
    const indices = readAccessor(level.glb, primitive.indices!);
    for (let t = 0; t < indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = key(indices[t + e]!);
        const b = key(indices[t + ((e + 1) % 3)]!);
        const id = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(id, (edges.get(id) ?? 0) + 1);
      }
    }
    assert.equal([...edges.values()].filter((n) => n === 1).length, 0);
  }
});

test("ratio 1 keeps every vertex and triangle, and the same input gives the same output", async () => {
  const source = parseGlb(skinnedSphere());
  const [same] = await simplifyPrimitives(source, 1);
  assert.equal(same!.vertexSources.length, (LAT + 1) * (LON + 1));
  assert.equal(same!.indices.length / 3, same!.sourceTriangles);
  const level = await levelGlb(source, 1, 1);
  assert.equal(level.triangles, measure(source).triangles);
  const a = writeGlb((await levelGlb(source, 0.25, 2)).glb);
  const b = writeGlb((await levelGlb(source, 0.25, 2)).glb);
  assert.deepEqual(a, b);
});

test("appendSimplifiedMesh copies primitives it was not given", async () => {
  const source = parseGlb(skinnedSphere());
  source.json.meshes![0]!.primitives.push({ attributes: { POSITION: 0 }, mode: 0 });
  const simplified = await simplifyPrimitives(source, 0.5);
  assert.equal(simplified.length, 1);
  const index = appendSimplifiedMesh(source, 0, simplified, 3);
  const mesh = source.json.meshes![index]!;
  assert.equal(mesh.primitives[1]!.attributes["POSITION"], 0);
  assert.notEqual(mesh.primitives[0]!.attributes["POSITION"], 0);
});
