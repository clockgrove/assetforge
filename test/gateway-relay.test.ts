import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { VercelGateway } from "../src/gateway/vercel.ts";

test("inside a Factory stage, gateway calls go to the relay at the gateway SDK's own /v4/ai path", async () => {
  const seen: Array<{ path: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    req.resume();
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "relay test", type: "invalid_request_error" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const { port } = server.address() as AddressInfo;
    const gateway = VercelGateway.fromEnv({
      AI_GATEWAY_API_KEY: "relay-token",
      FACTORY_GATEWAY_URL: `http://127.0.0.1:${port}/`,
    });
    await assert.rejects(
      gateway.analyzeImages({ model: "openai/gpt-5", prompt: "hello", images: [] }),
    );
    assert.ok(seen.length > 0, "the relay received the call");
    for (const { path, auth } of seen) {
      assert.match(path, /^\/v4\/ai\//);
      assert.equal(auth, "Bearer relay-token");
    }
  } finally {
    server.close();
  }
});
