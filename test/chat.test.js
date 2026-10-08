const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const express = require("express");
const chatRouter = require("../src/routes/chat");

const posixOnly = { skip: process.platform === "win32" ? "QODERCLI_BIN is ignored on Windows" : false };

async function streamWithFakeCli(exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-proxy-chat-"));
  const binary = path.join(dir, "qodercli");
  const originalBinary = process.env.QODERCLI_BIN;
  const assistant = {
    type: "assistant",
    subtype: "message",
    message: { content: [{ type: "text", text: "ACCIO_PROXY_OK" }] },
  };
  fs.writeFileSync(binary, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(assistant))});\nprocess.exit(${exitCode});\n`, { mode: 0o755 });
  process.env.QODERCLI_BIN = binary;

  const app = express();
  app.use(express.json());
  app.use("/v1/chat/completions", chatRouter);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        stream: true,
        messages: [{ role: "user", content: "Return ACCIO_PROXY_OK." }],
        tools: [{ type: "function", function: { name: "probe", description: "Probe", parameters: { type: "object", properties: {} } } }],
      }),
    });
    const body = await response.text();
    const events = body.split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice(6)));
    return { status: response.status, body, events };
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    if (originalBinary === undefined) delete process.env.QODERCLI_BIN;
    else process.env.QODERCLI_BIN = originalBinary;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("streams plain text when tools are available but not called", posixOnly, async () => {
  const { status, events } = await streamWithFakeCli(0);
  assert.equal(status, 200);
  assert.equal(events.map((event) => event.choices[0].delta.content || "").join(""), "ACCIO_PROXY_OK");
  assert.equal(events.at(-1).choices[0].finish_reason, "stop");
});

test("reports CLI failure without a successful text completion", posixOnly, async () => {
  const { status, body, events } = await streamWithFakeCli(1);
  assert.equal(status, 200);
  assert.equal(events.some((event) => event.choices?.[0]?.delta?.content === "ACCIO_PROXY_OK"), false);
  assert.equal(events.at(-1).error.type, "api_error");
  assert.equal(body.includes("data: [DONE]"), false);
});
