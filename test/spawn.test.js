const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runQoderRequest } = require("../src/helpers/spawn");
const posixOnly = { skip: process.platform === "win32" ? "QODERCLI_BIN is ignored on Windows" : false };

async function collectChunks(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-proxy-stream-"));
  const binary = path.join(dir, "qodercli");
  const originalBinary = process.env.QODERCLI_BIN;
  fs.writeFileSync(
    binary,
    `#!/usr/bin/env node\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,
    { mode: 0o755 },
  );
  process.env.QODERCLI_BIN = binary;

  try {
    const chunks = [];
    await new Promise((resolve, reject) => {
      runQoderRequest({
        prompt: "test",
        model: "auto",
        timeoutMs: 5000,
        onChunk: (chunk) => chunks.push(chunk),
        onDone: (code, stderr) => code === 0 ? resolve() : reject(new Error(stderr)),
        onError: reject,
      });
    });
    return chunks.map((chunk) => chunk.message.content[0].text);
  } finally {
    if (originalBinary === undefined) delete process.env.QODERCLI_BIN;
    else process.env.QODERCLI_BIN = originalBinary;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("ignores system hook text when an assistant message follows", posixOnly, async () => {
  const chunks = await collectChunks([
    { type: "system", subtype: "hook_response", result: { text: "HOOK_NOISE" } },
    { type: "assistant", subtype: "message", message: { content: [{ type: "text", text: "ACCIO_PROXY_OK" }] } },
    { type: "result", subtype: "success", result: "ACCIO_PROXY_OK" },
  ]);
  assert.deepEqual(chunks, ["ACCIO_PROXY_OK"]);
});

test("uses a successful result only when no assistant message exists", posixOnly, async () => {
  const chunks = await collectChunks([
    { type: "system", subtype: "hook_response", result: { text: "HOOK_NOISE" } },
    { type: "result", subtype: "success", result: "ACCIO_PROXY_OK" },
  ]);
  assert.deepEqual(chunks, ["ACCIO_PROXY_OK"]);
});
