import assert from "node:assert/strict";
import { test } from "node:test";
import { createRaster } from "../src/image/raster.ts";
import type { Raster } from "../src/image/raster.ts";
import { parseGlb } from "../src/model3d/glb.ts";
import {
  GROOM_REGIONS,
  groomMaps,
  groomMaskCheck,
  markerMask,
  padMask,
  texelRegions,
} from "../src/model3d/lookdev/groom.ts";
import type { GroomSkeleton, SeasonGroom } from "../src/model3d/lookdev/groom.ts";
import {
  depthMap,
  dilate,
  fillUnseen,
  projectViews,
  seamError,
} from "../src/model3d/lookdev/project.ts";
import { editedBackground } from "../src/model3d/lookdev/command.ts";
import { bakeTexels } from "../src/model3d/lookdev/texels.ts";
import { viewCamera } from "../src/model3d/render.ts";
import { boundsOf, posedPrimitives } from "../src/model3d/scene.ts";
import { syntheticCharacter } from "./fixtures/glb.ts";

const SIZE = 64;

function character() {
  const glb = parseGlb(syntheticCharacter({ triangles: 108, joints: 3 }));
  const texels = bakeTexels(glb, SIZE);
  return { glb, texels };
}

function uniform(width: number, height: number, rgb: [number, number, number]): Raster {
  const r = createRaster(width, height);
  for (let i = 0; i < width * height; i++) r.data.set([...rgb, 255], i * 4);
  return r;
}

function views(glb: ReturnType<typeof character>["glb"], rgb: [number, number, number]) {
  const framing = boundsOf(posedPrimitives(glb))!;
  const list = [0, 90, 180, 270].map((yawDeg) => {
    const camera = viewCamera({ sizePx: 96, yawDeg, framing });
    return { camera, image: uniform(96, 96, rgb) };
  });
  return { list, depths: list.map((v) => depthMap(glb, v.camera)) };
}

function count(mask: Uint8Array): number {
  return mask.reduce((n, v) => n + (v ? 1 : 0), 0);
}

test("bakeTexels covers the textured triangles with positions, normals and joints", () => {
  const { texels } = character();
  const covered = count(texels.covered);
  assert.ok(covered > SIZE * SIZE * 0.5, `covered ${covered}`);
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!texels.covered[i]) continue;
    const n = Math.hypot(
      texels.normal[i * 3]!,
      texels.normal[i * 3 + 1]!,
      texels.normal[i * 3 + 2]!,
    );
    assert.ok(Math.abs(n - 1) < 1e-4);
    assert.ok(texels.joint[i]! >= 0 && texels.joint[i]! < 3);
    assert.ok(
      texels.position[i * 3 + 1]! >= 0.5 - 1e-4 && texels.position[i * 3 + 1]! <= 2.5 + 1e-4,
    );
  }
  assert.equal(
    bakeTexels(parseGlb(syntheticCharacter()), 16, 5).covered.some((v) => v),
    false,
  );
});

test("projecting a uniform view gives that colour on visible texels", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [100, 150, 200]);
  const projection = projectViews(glb, texels, list, depths);
  assert.ok(projection.coverage > 0.5, `coverage ${projection.coverage}`);
  let seen = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (projection.weight[i]! <= 0) continue;
    seen++;
    assert.deepEqual([...projection.color.data.subarray(i * 4, i * 4 + 4)], [100, 150, 200, 255]);
  }
  assert.ok(seen > 0);
});

test("views that disagree on a texel give it the squarer view's colour, not their grey mean", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [0, 0, 0]);
  // The front paints the coat dark, a three-quarter view paints it pale: a marking one view drew.
  const dark: [number, number, number] = [40, 40, 40];
  const pale: [number, number, number] = [220, 200, 180];
  const framing = boundsOf(posedPrimitives(glb))!;
  const oblique = viewCamera({ sizePx: 96, yawDeg: 45, framing });
  const two = [
    { ...list[0]!, image: uniform(96, 96, dark) },
    { camera: oblique, image: uniform(96, 96, pale) },
  ];
  const twoDepths = [depths[0]!, depthMap(glb, oblique)];
  const both = projectViews(glb, texels, two, twoDepths);
  const front = projectViews(glb, texels, [two[0]!], [twoDepths[0]!]);
  const side = projectViews(glb, texels, [two[1]!], [twoDepths[1]!]);
  let shared = 0;
  let mixed = 0;
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!(front.weight[i]! > 0 && side.weight[i]! > 0)) continue;
    shared++;
    const c = [...both.color.data.subarray(i * 4, i * 4 + 3)];
    const near = (rgb: number[]) => Math.hypot(...c.map((v, k) => v - rgb[k]!)) < 40;
    if (!near(dark) && !near(pale)) mixed++;
  }
  assert.ok(shared > 20, `shared ${shared}`);
  assert.ok(mixed / shared < 0.3, `${mixed} of ${shared} shared texels are a mix of both views`);
});

test("a restyle's background is never projected, and pale coat inside the figure still is", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [100, 150, 200]);
  // The restyle drew the figure narrower than the model: its left half is the background grey.
  const narrowed = list.map((v) => {
    const image = uniform(96, 96, [100, 150, 200]);
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 48; x++) image.data.set([216, 216, 216, 255], (y * 96 + x) * 4);
    return { ...v, image, background: editedBackground(image) };
  });
  const projection = projectViews(glb, texels, narrowed, depths);
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (projection.weight[i]! <= 0) continue;
    assert.deepEqual([...projection.color.data.subarray(i * 4, i * 4 + 4)], [100, 150, 200, 255]);
  }
  assert.ok(projection.coverage > 0);

  // A background-coloured patch enclosed by the figure is coat, not background.
  const enclosed = uniform(20, 20, [216, 216, 216]);
  for (let y = 4; y < 16; y++)
    for (let x = 4; x < 16; x++)
      enclosed.data.set(
        x >= 8 && x < 12 && y >= 8 && y < 12 ? [214, 214, 214, 255] : [90, 60, 40, 255],
        (y * 20 + x) * 4,
      );
  const mask = editedBackground(enclosed, undefined, 24, 1);
  assert.equal(mask[0], 1);
  assert.equal(mask[10 * 20 + 10], 0, "the enclosed pale patch is kept");
  assert.equal(mask[4 * 20 + 4], 1, "the figure's edge pixel is grown into the mask");
  assert.equal(mask[6 * 20 + 6], 0);
});

test("fillUnseen fills every covered texel and dilate adds a ring", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [100, 150, 200]);
  // One view leaves most texels unseen.
  const projection = projectViews(glb, texels, [list[0]!], [depths[0]!]);
  assert.ok(projection.coverage < 1);
  const source = uniform(32, 32, [100, 150, 200]);
  const filled = fillUnseen(projection, texels, source);
  assert.equal(filled.width, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!texels.covered[i]) continue;
    assert.deepEqual([...filled.data.subarray(i * 4, i * 4 + 4)], [100, 150, 200, 255]);
  }
  const edge = createRaster(8, 8);
  const covered = new Uint8Array(64);
  for (const x of [3, 4])
    for (const y of [3, 4]) {
      covered[y * 8 + x] = 1;
      edge.data.set([200, 10, 10, 255], (y * 8 + x) * 4);
    }
  const grown = dilate(edge, covered, 1);
  assert.deepEqual(
    [...grown.data.subarray((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 4)],
    [200, 10, 10, 255],
  );
  assert.equal(grown.data[(0 * 8 + 0) * 4], 0);
  assert.equal(dilate(edge, covered, 3).data[0], 200);
});

test("fillUnseen gives unseen texels the colour their seen neighbours were painted, not the source's marking", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [0, 0, 0]);
  // The source marks one side of the body pale; the only view paints the whole front one dark colour.
  const dark: [number, number, number] = [60, 50, 40];
  const projection = projectViews(
    glb,
    texels,
    [{ ...list[0]!, image: uniform(96, 96, dark) }],
    [depths[0]!],
  );
  const source = createRaster(SIZE, SIZE);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const pale = texels.covered[i] && texels.position[i * 3]! > 0;
    source.data.set(pale ? [230, 220, 200, 255] : [120, 110, 100, 255], i * 4);
  }
  const filled = fillUnseen(projection, texels, source);
  const unseen = { pale: [] as number[], other: [] as number[] };
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!texels.covered[i] || projection.weight[i]! > 0) continue;
    (texels.position[i * 3]! > 0 ? unseen.pale : unseen.other).push(filled.data[i * 4]!);
  }
  assert.ok(
    unseen.pale.length > 10 && unseen.other.length > 10,
    JSON.stringify(unseen).length + "",
  );
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  // Both sides take the painted colour; the source's pale side does not show through.
  assert.ok(Math.abs(mean(unseen.pale) - dark[0]) < 15, `pale side ${mean(unseen.pale)}`);
  assert.ok(Math.abs(mean(unseen.other) - dark[0]) < 15, `other side ${mean(unseen.other)}`);
});

test("seamError is ~0 for a projected uniform texture and >0 across a colour change", () => {
  const { glb, texels } = character();
  const { list, depths } = views(glb, [100, 150, 200]);
  const projection = projectViews(glb, texels, list, depths);
  const texture = dilate(
    fillUnseen(projection, texels, uniform(SIZE, SIZE, [100, 150, 200])),
    texels.covered,
    4,
  );
  const good = seamError(glb, texture);
  assert.ok(good.edges > 0);
  assert.ok(good.mean < 1 && good.p95 < 1, JSON.stringify(good));

  const split = createRaster(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++)
      split.data.set(x < SIZE / 2 ? [250, 0, 0, 255] : [0, 0, 250, 255], (y * SIZE + x) * 4);
  }
  const bad = seamError(glb, split);
  assert.ok(bad.edges > 0 && bad.mean > 1 && bad.p95 > 1, JSON.stringify(bad));
});

const skeleton: GroomSkeleton = {
  forward: [0, 0, 1],
  joints: [
    { name: "pelvis", parent: -1, position: [0.3, 0.5, 0], role: "pelvis" },
    { name: "spine", parent: 0, position: [0.3, 1.5, 0], role: "spine" },
    { name: "head", parent: 1, position: [0.3, 2.5, 0], role: "head" },
  ],
};

const season = (tint?: SeasonGroom["tint"]): SeasonGroom => ({
  lengthMm: { face: 5, cheek: 20, head: 10, neck: 30, body: 40, leg: 15, tail: 60 },
  density: { face: 0.3, cheek: 0.5, head: 0.6, neck: 0.7, body: 0.9, leg: 0.5, tail: 0.8 },
  ...(tint && { tint }),
});

test("regions, markers and pads", () => {
  const { texels } = character();
  const regions = texelRegions(texels, skeleton);
  const used = new Set<string>();
  for (let i = 0; i < SIZE * SIZE; i++)
    if (texels.covered[i]) used.add(GROOM_REGIONS[regions[i]!]!);
  assert.ok(used.has("body") && used.has("face"), [...used].join());
  assert.ok(count(markerMask(texels, [{ point: [0.3, 2.5, 0.3], radius: 0.2 }])) > 0);
  assert.equal(count(markerMask(texels, [])), 0);
  // The fixture's faces share one UV square, so build the downward-facing texels by hand.
  const hand = { ...texels, normal: new Float32Array(texels.normal) };
  for (let i = 0; i < SIZE * SIZE; i++) hand.normal[i * 3 + 1] = -1;
  const ys = [...texels.covered].flatMap((c, i) => (c ? [texels.position[i * 3 + 1]!] : []));
  const top = Math.max(...ys);
  const low = Math.min(...ys);
  const under = padMask(hand, [{ ankle: [0.3, top + 1, 0], toe: [0.3, top + 1, 0.2] }], 5);
  assert.equal(count(under), count(texels.covered));
  assert.equal(
    count(padMask(hand, [{ ankle: [0.3, low - 1, 0], toe: [0.3, low - 1, 0.2] }], 5)),
    0,
  );
  assert.equal(
    count(padMask(texels, [{ ankle: [0.3, top + 1, 0], toe: [0.3, top + 1, 0.2] }], 5)),
    0,
  );
});

test("groom length is zero exactly on the bare mask; tint only with a season tint", () => {
  const { texels } = character();
  const regions = texelRegions(texels, skeleton);
  const bare = markerMask(texels, [{ point: [0.3, 2.5, 0.3], radius: 0.4 }]);
  assert.ok(count(bare) > 0);
  const plain = groomMaps(texels, regions, bare, season(), skeleton);
  assert.equal(plain.tint, undefined);
  assert.equal(plain.maxLengthM, 0.06);
  const check = groomMaskCheck(plain.length, texels, bare);
  assert.deepEqual(check, { ok: true, zeroOnBare: 0, zeroOutside: 0, bareTexels: count(bare) });
  for (let i = 0; i < SIZE * SIZE; i++) {
    if (!texels.covered[i] || bare[i]) continue;
    assert.ok(plain.length.data[i * 4]! >= 1);
    const d = [0, 1, 2].map((c) => (plain.direction.data[i * 4 + c]! / 255) * 2 - 1);
    const dot =
      d[0]! * texels.normal[i * 3]! +
      d[1]! * texels.normal[i * 3 + 1]! +
      d[2]! * texels.normal[i * 3 + 2]!;
    assert.ok(Math.abs(dot) < 0.05, `direction not tangent: ${dot}`);
  }
  const bareLength = plain.length.data.slice();
  bareLength[bare.indexOf(1) * 4] = 9;
  assert.equal(groomMaskCheck({ ...plain.length, data: bareLength }, texels, bare).ok, false);

  const tinted = groomMaps(
    texels,
    regions,
    bare,
    season({ color: [1, 0.5, 0], tipWeight: 0.5 }),
    skeleton,
  );
  assert.ok(tinted.tint);
  const at =
    bare.indexOf(0) === -1 ? 0 : texels.covered.findIndex((c, i) => c === 1 && bare[i] === 0);
  assert.deepEqual([...tinted.tint!.data.subarray(at * 4, at * 4 + 4)], [255, 128, 0, 128]);
  const bareAt = bare.indexOf(1);
  assert.equal(tinted.tint!.data[bareAt * 4 + 3], 0);
});
