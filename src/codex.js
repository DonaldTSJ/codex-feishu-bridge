import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexRunError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name ?? "CodexRunError";
    this.code = options.code;
  }
}

export async function getCodexVersion() {
  return new Promise((resolve) => {
    const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve(`unavailable: ${err.message}`);
    });
    child.on("close", (code) => {
      const text = output.trim();
      resolve(code === 0 && text ? text : `unavailable: exit ${code}`);
    });
  });
}

export async function runCodex({
  prompt,
  sessionId,
  workdir,
  sandbox,
  model,
  timeoutMs,
  signal
}) {
  if (!prompt.trim()) {
    throw new CodexRunError("empty prompt");
  }

  const args = sessionId
    ? ["exec", "resume", "--json", "--skip-git-repo-check", sessionId, "-"]
    : ["exec", "--json", "--cd", workdir, "--sandbox", sandbox, "--skip-git-repo-check", "-"];

  if (model) {
    const insertAt = sessionId ? 3 : 2;
    args.splice(insertAt, 0, "--model", model);
  }

  const child = spawn("codex", args, {
    cwd: workdir,
    stdio: ["pipe", "pipe", "pipe"]
  });

  let startedSessionId = sessionId;
  let finalText = "";
  let turnCompleted = false;
  let stderr = "";
  let stdoutRemainder = "";
  let settled = false;
  let timedOut = false;
  let aborted = false;
  let postCompletionStopped = false;
  let postCompletionTimer;

  const kill = (reason) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (reason === "timeout") timedOut = true;
    if (reason === "abort") aborted = true;
    if (reason === "post-completion") postCompletionStopped = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000).unref();
  };

  const onAbort = () => kill("abort");
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => kill("timeout"), timeoutMs);

  child.stdin.end(prompt);

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (stderr.length > 12000) stderr = stderr.slice(-12000);
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const readStdout = (async () => {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed);
        const parsed = parseCodexEvent(event);
        if (parsed.sessionId) startedSessionId = parsed.sessionId;
        if (parsed.finalText) finalText = parsed.finalText;
        if (parsed.turnCompleted) {
          turnCompleted = true;
          postCompletionTimer ??= setTimeout(() => kill("post-completion"), 2000);
          postCompletionTimer.unref();
        }
      } catch {
        stdoutRemainder += `${trimmed}\n`;
        if (stdoutRemainder.length > 12000) stdoutRemainder = stdoutRemainder.slice(-12000);
      }
    }
  })();

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  }).finally(() => {
    settled = true;
    clearTimeout(timer);
    if (postCompletionTimer) clearTimeout(postCompletionTimer);
    signal?.removeEventListener("abort", onAbort);
  });

  await readStdout.catch(() => {});

  if (aborted) {
    throw new CodexRunError("codex run aborted", { name: "AbortError", code: "ABORT_ERR" });
  }
  if (timedOut) {
    throw new CodexRunError(`codex timed out after ${Math.round(timeoutMs / 1000)}s`, {
      code: "ETIMEDOUT"
    });
  }
  if (!settled || (exitCode !== 0 && !(postCompletionStopped && turnCompleted && finalText))) {
    const detail = summarizeFailure(stderr || stdoutRemainder);
    throw new CodexRunError(`codex exited with code ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
  if (!turnCompleted && !finalText) {
    const detail = summarizeFailure(stderr || stdoutRemainder);
    throw new CodexRunError(`codex produced no final reply${detail ? `: ${detail}` : ""}`);
  }

  return {
    sessionId: startedSessionId,
    text: finalText.trim() || "(Codex completed without a text reply)"
  };
}

function parseCodexEvent(event) {
  if (!event || typeof event !== "object") return {};
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return { sessionId: event.thread_id };
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return { finalText: String(event.item.text ?? "") };
  }
  if (event.type === "turn.completed") {
    return { turnCompleted: true };
  }
  return {};
}

function summarizeFailure(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n")
    .slice(0, 1200);
}
