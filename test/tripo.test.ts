import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../src/errors.ts";
import { TripoProvider } from "../src/gateway/tripo.ts";

const KEY = "tsk_secret_key_123";
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function reply(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), { status });
}

function fake(options: {
  statuses?: string[];
  output?: Record<string, unknown>;
  credit?: number;
  createReply?: unknown;
  errorCode?: number;
  glb?: Uint8Array;
}) {
  const calls: Call[] = [];
  const statuses = [...(options.statuses ?? ["success"])];
  let uploads = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    if (url.endsWith("/upload/sts"))
      return reply({ code: 0, data: { image_token: `tok${++uploads}` } });
    if (url.endsWith("/user/balance")) return reply({ code: 0, data: { balance: 12.5 } });
    if (url.endsWith("/task")) {
      return reply(options.createReply ?? { code: 0, data: { task_id: "task-1" } });
    }
    if (url.includes("/task/task-1")) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return reply({
        code: 0,
        data: {
          task_id: "task-1",
          status,
          consumed_credit: options.credit ?? 30,
          ...(options.errorCode !== undefined && { error_code: options.errorCode }),
          output: options.output ?? { pbr_model: "https://cdn.example/m.glb?sig=1" },
        },
      });
    }
    if (url.startsWith("https://cdn.example/")) return new Response(options.glb ?? GLB);
    return reply({ code: 1, message: "unexpected" }, 404);
  };
  return { calls, fetch: impl as typeof fetch };
}

function provider(f: { fetch: typeof fetch }, sleeps: number[] = [], timeoutMs?: number) {
  return new TripoProvider({
    apiKey: KEY,
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    pollIntervalMs: 10,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
}

const png = (view: string) => ({ view, mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) });

test("multiview orders front, left, back, right with {} for a missing view", async () => {
  const f = fake({});
  const result = await provider(f).generateModel({
    model: "tripo",
    views: [png("back"), png("front"), png("left")],
    seed: 7,
    providerOptions: {
      tripo: { modelVersion: "v3", texture: true, pbr: true, usdPerCredit: 0.01 },
    },
  });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.deepEqual(create?.body, {
    type: "multiview_to_model",
    files: [
      { type: "png", file_token: "tok1" },
      { type: "png", file_token: "tok2" },
      { type: "png", file_token: "tok3" },
      {},
    ],
    model_version: "v3",
    texture: true,
    pbr: true,
    model_seed: 7,
  });
  assert.equal(f.calls[0]?.auth, `Bearer ${KEY}`);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/upload/sts")).length, 3);
  const download = f.calls.find((c) => c.url.startsWith("https://cdn.example/"));
  assert.equal(download?.auth, null);
  assert.equal(result.handle, "task-1");
  assert.equal(result.requestId, "task-1");
  assert.equal(result.requestIdSource, "provider");
  assert.equal(result.seed, 7);
  assert.ok(Math.abs((result.costUsd ?? 0) - 0.3) < 1e-9);
  assert.deepEqual(result.glb, GLB);
});

test("a single image falls back to image_to_model; no cost without a rate", async () => {
  const f = fake({});
  const result = await provider(f).generateModel({
    model: "tripo",
    views: [{ ...png("three-quarter"), mediaType: "image/jpeg" }],
  });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.deepEqual(create?.body, {
    type: "image_to_model",
    file: { type: "jpg", file_token: "tok1" },
  });
  assert.equal(result.costUsd, undefined);
  assert.equal("credits" in result, false);
});

test("front alone uses image_to_model", async () => {
  const f = fake({});
  await provider(f).generateModel({ model: "tripo", views: [png("front")] });
  const create = f.calls.find((c) => c.url.endsWith("/task") && c.method === "POST");
  assert.equal((create?.body as { type: string }).type, "image_to_model");
});

test("rig and retarget bodies", async () => {
  const rig = fake({ output: { model: "https://cdn.example/r.glb" } });
  await provider(rig).rigModel({
    model: "tripo",
    source: "task-0",
    rigType: "biped",
    providerOptions: { tripo: { spec: "tripo", modelVersion: "v2.5-20250123" } },
  });
  assert.deepEqual(rig.calls[0]?.body, {
    type: "animate_rig",
    original_model_task_id: "task-0",
    out_format: "glb",
    rig_type: "biped",
    spec: "tripo",
    model_version: "v2.5-20250123",
  });
  const anim = fake({ output: { base_model: "https://cdn.example/a.glb" } });
  await provider(anim).animateModel({
    model: "tripo",
    source: "task-0",
    clips: ["preset:walk", "preset:idle"],
  });
  assert.deepEqual(anim.calls[0]?.body, {
    type: "animate_retarget",
    original_model_task_id: "task-0",
    out_format: "glb",
    animations: ["preset:walk", "preset:idle"],
    bake_animation: true,
    export_with_geometry: true,
  });
});

test("polls queued, running, then success with the injected sleep", async () => {
  const f = fake({ statuses: ["queued", "running", "success"] });
  const sleeps: number[] = [];
  await provider(f, sleeps).rigModel({ model: "tripo", source: "t", rigType: "biped" });
  assert.deepEqual(sleeps, [10, 10]);
  assert.equal(f.calls.filter((c) => c.url.includes("/task/task-1")).length, 3);
});

test("failures become ProviderError without the key", async () => {
  const cases: Array<[ReturnType<typeof fake>, RegExp, number?]> = [
    [fake({ statuses: ["failed"], errorCode: 2002 }), /failed.*2002/],
    [fake({ statuses: ["banned"] }), /banned/],
    [
      fake({ createReply: { code: 1004, message: "invalid animation name: preset:bogus" } }),
      /invalid animation name: preset:bogus \(code 1004\)/,
    ],
    [fake({ glb: new Uint8Array([1, 2, 3, 4]) }), /not a binary glTF/],
    [fake({ output: {} }), /no model output/],
    [fake({ statuses: ["running"] }), /timed out/, 25],
  ];
  for (const [f, pattern, timeout] of cases) {
    await assert.rejects(
      provider(f, [], timeout).rigModel({ model: "tripo", source: "t", rigType: "biped" }),
      (error: Error) => {
        assert.ok(error instanceof ProviderError);
        assert.match(error.message, pattern);
        assert.ok(!error.message.includes(KEY));
        return true;
      },
    );
  }
});

test("balance reads the balance", async () => {
  assert.equal(await provider(fake({})).balance(), 12.5);
});

test("fromEnv without a key throws", () => {
  assert.throws(() => TripoProvider.fromEnv({}), { message: "TRIPO_API_KEY is not set" });
  assert.ok(TripoProvider.fromEnv({ TRIPO_API_KEY: KEY }) instanceof TripoProvider);
});
