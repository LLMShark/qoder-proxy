const { spawn } = require("child_process");
const fs = require("fs");
const { addSystem } = require("../store/logStore");
const config = require("../config");

const isBenignQoderStderr = (text) => {
  if (!text) return false;
  return (
    text.includes("failed to asynchronously prepare wasm") ||
    text.includes('function="_abort_js"') ||
    text.includes("Aborted(LinkError: WebAssembly.instantiate()")
  );
};

// Build the environment for every qodercli child process.
// config.QODER_PAT normalises both QODER_PERSONAL_ACCESS_TOKEN and QODER_API_KEY,
// so we always pass it under the name qodercli actually looks for.
const qoderEnv = () => ({
  ...process.env,
  // Always pass the PAT under the name qodercli expects, regardless of which
  // env var name the hosting platform used.
  ...(config.QODER_PAT
    ? { QODER_PERSONAL_ACCESS_TOKEN: config.QODER_PAT }
    : {}),
  // Prevent qodercli from trying to open a browser (headless container has none).
  NO_BROWSER: "1",
  // Signal a non-interactive / CI environment so qodercli skips TUI features.
  CI: "1",
  // Ensure HOME is set so qodercli can find ~/.qoder config (auto-updates off).
  HOME: process.env.HOME || "/root",
});

const getQoderCliCommand = () => {
  if (process.platform === "win32")
    return { cmd: "qodercli.cmd", viaCmd: true };

  // Allow explicit override in container/runtime env.
  if (process.env.QODERCLI_BIN)
    return { cmd: process.env.QODERCLI_BIN, viaCmd: false };

  // Common global npm binary locations in Linux containers.
  const candidates = [
    "/usr/local/bin/qodercli",
    "/usr/bin/qodercli",
    "qodercli",
  ];
  for (const c of candidates) {
    if (c.includes("/") && fs.existsSync(c)) return { cmd: c, viaCmd: false };
  }
  return { cmd: "qodercli", viaCmd: false };
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const spawnQoderCli = (prompt, model, flags = []) => {
  const qoder = getQoderCliCommand();
  if (process.platform === "win32") {
    // On Windows, pass a cmd-safe prompt to avoid shell interpretation of
    // special characters (&, |, >, <, ^, ").
    const safePrompt = prompt.replace(/"/g, '\\"').replace(/[&|<>^]/g, "^$&");
    const args = ["/c", qoder.cmd, "-p", safePrompt, "-f", "stream-json"];
    if (model) args.push("--model", model);
    if (flags.length) args.push(...flags);
    return spawn("cmd.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: qoderEnv(),
    });
  } else {
    const args = ["-p", prompt, "-f", "stream-json"];
    if (model) args.push("--model", model);
    if (flags.length) args.push(...flags);
    return spawn(qoder.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: qoderEnv(),
    });
  }
};

const parseStreamJsonLine = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const hasVisibleAssistantText = (data) => {
  const content = data?.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part) return false;
    if (typeof part === "string") return part.trim().length > 0;
    if (typeof part.text === "string" && part.text.trim()) return true;
    if (typeof part.value === "string" && part.value.trim()) return true;
    return false;
  });
};

const deepFindText = (value, depth = 0) => {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = deepFindText(item, depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof value === "object") {
    // Prefer common text-bearing keys first.
    const priorityKeys = [
      "text",
      "value",
      "result",
      "output",
      "content",
      "message",
      "final",
      "answer",
    ];
    for (const key of priorityKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const t = deepFindText(value[key], depth + 1);
        if (t) return t;
      }
    }
  }
  return "";
};

const extractEventText = (data) => {
  if (!data || typeof data !== "object") return "";

  // 1) Primary assistant message content
  const msgContent = data?.message?.content;
  if (typeof msgContent === "string" && msgContent.trim()) return msgContent;
  if (Array.isArray(msgContent)) {
    const joined = msgContent
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.value === "string") return part.value;
        if (typeof part?.text?.value === "string") return part.text.value;
        return "";
      })
      .join("");
    if (joined.trim()) return joined;
  }

  // 2) qodercli result event variants
  if (typeof data.result === "string" && data.result.trim()) return data.result;
  if (data.result && typeof data.result === "object") {
    if (typeof data.result.text === "string" && data.result.text.trim()) {
      return data.result.text;
    }
    if (typeof data.result.value === "string" && data.result.value.trim()) {
      return data.result.value;
    }
    if (
      typeof data.result?.text?.value === "string" &&
      data.result.text.value.trim()
    ) {
      return data.result.text.value;
    }
  }

  // 3) Last-resort generic deep scan for textual payloads from unknown schemas.
  return deepFindText(data);
};

// ---------------------------------------------------------------------------
// Public: run a qodercli request
// ---------------------------------------------------------------------------

/**
 * Spawn qodercli and wire up all event handlers in one place.
 *
 * @param {object} opts
 * @param {string}   opts.prompt
 * @param {string}   opts.model
 * @param {string[]} opts.flags       - extra CLI flags (e.g. --max-tokens 512)
 * @param {number}   opts.timeoutMs   - kill + error after this many ms (0 = no limit)
 * @param {function} opts.onChunk     - called with raw qodercli `data` object for each assistant message
 * @param {function} opts.onDone      - called with (exitCode, stderrOutput) when process exits normally
 * @param {function} opts.onError     - called with an Error when spawn fails or timeout fires
 *
 * @returns {ChildProcess} - so callers can kill() on client disconnect
 */
const runQoderRequest = ({
  prompt,
  model,
  flags = [],
  timeoutMs = 120_000,
  onChunk,
  onDone,
  onError,
}) => {
  let buffer = "";
  let stderrOutput = "";
  let settled = false;
  let timeoutHandle;
  let sawAssistantMessage = false;
  let lastSyntheticText = "";

  const settle = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutHandle);
    fn();
  };

  const child = spawnQoderCli(prompt, model, flags);

  child.on("error", (err) => {
    console.error("[qodercli error]", err.message);
  });

  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      child.kill();
      settle(() =>
        onError(
          Object.assign(new Error(`qodercli timed out after ${timeoutMs}ms`), {
            code: "TIMEOUT",
          }),
        ),
      );
    }, timeoutMs);
  }

  // ── KEY CHANGE: process stdout line-by-line as it arrives ──────────────────
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    // Keep the last incomplete line in the buffer
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const data = JSON.parse(trimmed);
        if (
          data.type === "assistant" &&
          (data.subtype === "message" || data.message?.type === "message")
        ) {
          if (hasVisibleAssistantText(data)) sawAssistantMessage = true;
          onChunk(data);
        } else if (data.type === "result" && !data.is_error) {
          // System hook events may contain text, but are not model output.
          const fallbackText = extractEventText(data);
          if (!fallbackText || sawAssistantMessage) continue;
          if (fallbackText === lastSyntheticText) continue;
          lastSyntheticText = fallbackText;
          onChunk({
            type: "assistant",
            subtype: "message",
            message: {
              content: [{ type: "text", text: fallbackText }],
            },
          });
        }
      } catch {
        // Plain text line (not JSON) — wrap it into a fake message object
        if (trimmed && !trimmed.startsWith("{")) {
          onChunk({
            type: "assistant",
            subtype: "message",
            message: {
              content: [{ type: "text", text: trimmed }],
            },
          });
        }
      }
    }
  });

  // Flush any remaining buffer content when stdout closes
  child.stdout.on("end", () => {
    const trimmed = buffer.trim();
    if (!trimmed) return;

    try {
      const data = JSON.parse(trimmed);
      if (
        data.type === "assistant" &&
        (data.subtype === "message" || data.message?.type === "message")
      ) {
        if (hasVisibleAssistantText(data)) sawAssistantMessage = true;
        onChunk(data);
      } else if (data.type === "result" && !data.is_error) {
        const fallbackText = extractEventText(data);
        if (!fallbackText || sawAssistantMessage) return;
        if (fallbackText === lastSyntheticText) return;
        lastSyntheticText = fallbackText;
        onChunk({
          type: "assistant",
          subtype: "message",
          message: {
            content: [{ type: "text", text: fallbackText }],
          },
        });
      }
    } catch {
      if (!trimmed.startsWith("{")) {
        onChunk({
          type: "assistant",
          subtype: "message",
          message: {
            content: [{ type: "text", text: trimmed }],
          },
        });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    stderrOutput += text + "\n";
    if (!isBenignQoderStderr(text)) {
      addSystem(text, "error", "qodercli-stderr");
    }
  });

  child.on("close", (code, signal) => {
    const finalCode = code == null && signal ? -1 : code;
    const finalStderr = signal
      ? `${stderrOutput.trim()}${stderrOutput.trim() ? "\n" : ""}Process terminated by signal: ${signal}`
      : stderrOutput.trim();
    settle(() => onDone(finalCode, finalStderr));
  });

  child.on("error", (err) => {
    addSystem(err.message, "error", "qodercli-spawn");
    settle(() => onError(err));
  });

  return child;
};

// ---------------------------------------------------------------------------
// Public: startup health check
// ---------------------------------------------------------------------------

/**
 * Check whether qodercli is available on PATH.
 * Resolves to "available", null, or "timeout".
 */
const checkQoderCli = () =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (val) => {
      if (!done) {
        done = true;
        resolve(val);
      }
    };

    const qoder = getQoderCliCommand();

    // In Linux containers, if we already resolved an absolute binary path and
    // it exists, treat qodercli as available immediately. This avoids false
    // startup timeouts caused by slow/hanging CLI help/version commands.
    if (
      process.platform !== "win32" &&
      qoder.cmd.includes("/") &&
      fs.existsSync(qoder.cmd)
    ) {
      return finish("available");
    }

    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/c", qoder.cmd, "--help"], {
            stdio: ["ignore", "pipe", "pipe"],
            env: qoderEnv(),
          })
        : spawn(qoder.cmd, ["--help"], {
            stdio: ["ignore", "pipe", "pipe"],
            env: qoderEnv(),
          });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      // Lightweight availability check: any output or normal close means
      // binary is present and launchable.
      const output = (stdout || stderr).trim();
      finish(output || code !== null ? "available" : null);
    });

    // ENOENT = binary genuinely not on PATH; any other error still means it exists
    child.on("error", (err) => {
      finish(err.code === "ENOENT" ? null : "installed");
    });

    // Hard timeout so startup is never blocked
    setTimeout(() => {
      child.kill();
      finish("timeout");
    }, 8000);
  });

module.exports = { runQoderRequest, checkQoderCli };
