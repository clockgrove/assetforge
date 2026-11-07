import assert from "node:assert/strict";
import { test } from "node:test";
import { Budget } from "../src/budget.ts";
import { Caller } from "../src/calls.ts";
import { ScriptedProvider } from "../src/gateway/scripted.ts";
import { defaultRoutes } from "../src/routes.ts";
import type { LoadedReference } from "../src/types.ts";
import {
  buildGroupingPrompt,
  checkConfirmed,
  familyFrames,
  parseGrouping,
  proposeGrouping,
} from "../src/sheet/group.ts";

const ids = [1, 2, 3, 4, 5, 6];

function ref(role: string, byte: number): LoadedReference {
  return {
    role,
    path: `${role}.png`,
    mediaType: "image/png",
    bytes: new Uint8Array([byte]),
    sha256: `hash-${byte}`,
  };
}

function setup(reply: string) {
  const provider = new ScriptedProvider({
    image: () => {
      throw new Error("no image call expected");
    },
    vision: () => ({ text: reply }),
  });
  const budget = new Budget(1);
  const call = new Caller({ provider, providerName: "scripted", budget, routes: defaultRoutes });
  return { provider, budget, call };
}

const goodReply = JSON.stringify({
  families: [
    { name: "Walk Right", frames: [3, 4, 5], reason: "steps in sequence" },
    { name: "walk-left", mirrorOf: "walk-right", reason: "the right walk flipped" },
    { name: "idle", frames: [1, 2], reason: "standing" },
  ],
  unassigned: [6],
  notes: "ok",
});

test("a scripted vision reply becomes a proposed grouping with provenance and cost", async () => {
  const { provider, budget, call } = setup(`Here you go:\n\`\`\`json\n${goodReply}\n\`\`\``);
  const input = {
    frameIds: ids,
    subject: "cat",
    hints: ["idle", "walk-right"],
    referenceRoles: ["identity"],
  };
  const grouping = await proposeGrouping(call, ref("contact", 1), [ref("identity", 2)], input);

  assert.equal(grouping.status, "proposed");
  assert.deepEqual(
    grouping.families.map((f) => f.name),
    ["walk-right", "walk-left", "idle"],
  );
  assert.deepEqual(grouping.families[0]?.frames, [3, 4, 5]);
  assert.equal(grouping.families[1]?.mirrorOf, "walk-right");
  assert.equal(grouping.families[2]?.reason, "standing");
  assert.deepEqual(grouping.unassigned, [6]);

  const sent = provider.calls[0];
  assert.equal(sent?.kind, "vision");
  if (sent?.kind !== "vision") return;
  assert.deepEqual(Array.from(sent.request.images[0]?.bytes ?? []), [1]);
  assert.equal(sent.request.images.length, 2);
  assert.match(sent.request.prompt, /1, 2, 3, 4, 5, 6/);
  assert.match(sent.request.prompt, /idle, walk-right/);
  assert.match(sent.request.prompt, /"identity"/);

  assert.equal(call.records.length, 1);
  assert.equal(call.records[0]?.operation, "vision");
  assert.deepEqual(grouping.proposedBy, {
    model: call.records[0]?.model,
    requestId: call.records[0]?.requestId,
  });
  assert.ok(budget.spentUsd > 0);
});

test("buildGroupingPrompt works without optional inputs", () => {
  const prompt = buildGroupingPrompt({ frameIds: [1, 2] });
  assert.match(prompt, /1, 2/);
  assert.doesNotMatch(prompt, /Suggested family names/);
});

test("messy replies are cleaned", () => {
  const text = JSON.stringify({
    families: [
      { name: "Walk_Right", frames: [1, 2, 2, 99, 3] },
      { name: "walk-left", mirrorOf: "nowhere", frames: [4], reason: "own frames" },
      { name: "self", mirrorOf: "self", frames: [5], reason: "x" },
    ],
  });
  const g = parseGrouping(`prose ${text} more`, ids);
  assert.equal(g.families[0]?.name, "walk-right");
  assert.deepEqual(g.families[0]?.frames, [1, 2, 3]);
  assert.equal(g.families[0]?.reason, "no reason given");
  assert.equal(g.families[1]?.mirrorOf, undefined);
  assert.equal(g.families[2]?.mirrorOf, undefined);
  assert.deepEqual(g.unassigned, [6]);
  assert.match(g.notes ?? "", /unknown frame 99/);
  assert.match(g.notes ?? "", /duplicate frame 2/);
  assert.match(g.notes ?? "", /nowhere/);
});

test("an unparseable reply throws", () => {
  assert.throws(() => parseGrouping("I cannot tell.", ids), /families array/);
  assert.throws(() => parseGrouping('{"families": 3}', ids), /families array/);
});

const confirmed = () => ({
  status: "confirmed",
  families: [
    { name: "walk-right", frames: [3, 4, 3], reason: "hold" },
    { name: "walk-left", mirrorOf: "walk-right", reason: "flip" },
    { name: "idle", frames: [3, 1], reason: "shares a frame" },
  ],
  unassigned: [],
});

test("checkConfirmed refuses a proposal and accepts a confirmed edit", () => {
  assert.throws(
    () => checkConfirmed({ ...confirmed(), status: "proposed" }, ids),
    /set status to "confirmed"/,
  );
  const g = checkConfirmed(confirmed(), ids);
  assert.equal(g.status, "confirmed");
  assert.deepEqual(familyFrames(g, "walk-left"), { frames: [3, 4, 3], mirrored: true });
  assert.deepEqual(familyFrames(g, "idle"), { frames: [3, 1], mirrored: false });
  assert.throws(() => familyFrames(g, "nope"), /no family/);
});

test("checkConfirmed refuses invalid edits", () => {
  const edit = (change: (g: ReturnType<typeof confirmed>) => void) => {
    const g = confirmed();
    change(g);
    return () => checkConfirmed(g, ids);
  };
  assert.throws(
    edit((g) => void (g.families[0]!.frames = [1, 42])),
    /unknown frame 42/,
  );
  assert.throws(
    edit((g) => void (g.families[1]!.mirrorOf = "missing")),
    /not another family/,
  );
  assert.throws(
    edit((g) => {
      g.families[2] = { name: "idle", mirrorOf: "walk-left", reason: "chain" } as never;
    }),
    /no mirror chains/,
  );
  assert.throws(
    edit((g) => void (g.families[2]!.name = "walk-right")),
    /duplicate family name/,
  );
  assert.throws(
    edit((g) => void (g.families[2]!.name = "Bad Name")),
    /lowercase/,
  );
  assert.throws(
    edit((g) => void (g.families = [])),
    /no families/,
  );
  assert.throws(
    edit((g) => void (g.families[1]!.frames = [1] as never)),
    /both frames and mirrorOf/,
  );
  assert.throws(
    edit((g) => void (g.families[0]!.frames = [])),
    /neither/,
  );
});
