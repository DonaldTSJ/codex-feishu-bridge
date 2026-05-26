import { createReadStream, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Domain, LoggerLevel, createLarkChannel } from "@larksuiteoapi/node-sdk";
import { getCodexVersion, runCodex } from "./codex.js";
import {
  buildCodexImagePrompt,
  cleanImageCaption,
  ensureImageOutputDir,
  parseImageCommand,
  resolveImageResult
} from "./image.js";
import { SessionStore } from "./sessions.js";

const bridgeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = readConfig();
const sessions = new SessionStore();
const chains = new Map();
const running = new Set();
const queued = new Map();
const activeControllers = new Map();

await sessions.load();

const codexVersion = await getCodexVersion();
if (codexVersion.startsWith("unavailable:")) {
  console.error(`Codex CLI is not available: ${codexVersion}`);
  process.exit(1);
}
if (!existsSync(config.workdir)) {
  console.error(`CODEX_WORKDIR does not exist: ${config.workdir}`);
  process.exit(1);
}

const channel = createLarkChannel({
  appId: config.appId,
  appSecret: config.appSecret,
  domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
  source: "codex-feishu-bridge",
  loggerLevel: LoggerLevel.info,
  policy: {
    dmMode: "open",
    requireMention: false,
    respondToMentionAll: false
  },
  safety: {
    chatQueue: { enabled: false }
  },
  includeRawEvent: true
});

const larkClient = new Client({
  appId: config.appId,
  appSecret: config.appSecret,
  domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu
});

channel.on({
  message: (msg) => {
    void handleMessage(msg).catch((err) => {
      console.error("[message] failed:", err?.stack ?? err?.message ?? String(err));
    });
  },
  reject: (evt) => {
    console.warn("[reject]", evt?.reason ?? evt);
  },
  reconnecting: () => {
    console.warn("[ws] reconnecting");
  },
  reconnected: () => {
    console.log("[ws] reconnected");
  },
  error: (err) => {
    console.error("[ws] error:", err?.message ?? String(err));
  }
});

await channel.connect();

console.log(
  [
    "Codex Feishu bridge connected.",
    `bot=${channel.botIdentity?.name ?? "unknown"}`,
    `openId=${channel.botIdentity?.openId ?? "-"}`,
    `workdir=${config.workdir}`,
    `codex=${codexVersion}`
  ].join("  ")
);
console.log("Listening for Feishu/Lark messages. Press Ctrl+C to exit.");

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function handleMessage(msg) {
  const scope = msg.chatId;
  if (!scope) return;
  if (msg.senderId && msg.senderId === channel.botIdentity?.openId) return;
  if (msg.chatType !== "p2p" && config.requireMentionInGroup && !msg.mentionedBot) return;

  const text = normalizeMessageText(msg);
  if (!text) return;

  if (text === "/new" || text === "/reset") {
    abortActive(scope);
    sessions.clear(scope);
    console.log(`[message] ${scope} command=/new`);
    await sendMarkdown(msg, "已清空当前 chat 的 Codex session。");
    return;
  }

  if (text === "/status") {
    console.log(`[message] ${scope} command=/status`);
    await sendMarkdown(msg, statusText(scope));
    return;
  }

  const imageRequest = parseImageCommand(text);
  const isImageRequest = Boolean(imageRequest);
  console.log(`[message] ${scope} queued chars=${text.length}`);
  const position = incrementQueue(scope);
  await sendMarkdown(
    msg,
    position > 1
      ? `Codex 已排队（前面还有 ${position - 1} 个任务）。`
      : isImageRequest
        ? "Codex 正在生成图片。"
        : "Codex 执行中。"
  );

  enqueue(scope, async () => {
    const controller = new AbortController();
    activeControllers.set(scope, controller);
    try {
      if (imageRequest) {
        await runImageTask({ msg, scope, prompt: imageRequest.prompt, signal: controller.signal });
      } else {
        await runTextTask({ msg, scope, prompt: text, signal: controller.signal });
      }
    } catch (err) {
      if (err?.name === "AbortError") return;
      console.error(`[codex] ${scope} failed:`, err?.message ?? String(err));
      await sendMarkdown(msg, `Codex 执行失败：\n\n\`\`\`\n${clip(err?.message ?? String(err), 1800)}\n\`\`\``);
    } finally {
      if (activeControllers.get(scope) === controller) activeControllers.delete(scope);
      decrementQueue(scope);
    }
  });
}

async function runTextTask({ msg, scope, prompt, signal }) {
  const previousSessionId = sessions.get(scope);
  const startedAt = Date.now();
  console.log(`[codex] ${scope} start type=text resume=${previousSessionId ? "yes" : "no"} queue=${queued.get(scope) ?? 0}`);
  const result = await runCodex({
    prompt,
    sessionId: previousSessionId,
    workdir: config.workdir,
    sandbox: config.sandbox,
    model: config.model,
    timeoutMs: config.timeoutMs,
    signal
  });
  if (result.sessionId) sessions.set(scope, result.sessionId);

  const imageResult = await resolveImageResult({
    text: result.text,
    outputDir: config.imageOutputDir,
    workdir: config.workdir,
    sinceMs: startedAt,
    maxBytes: config.imageMaxBytes
  });
  if (imageResult.path) {
    console.log(`[codex] ${scope} text result includes image=${imageResult.path}`);
    await sendImageReply(msg, imageResult.path);
  }

  console.log(`[codex] ${scope} done type=text session=${result.sessionId ?? "-"}`);
  await sendMarkdown(msg, withCodexFooter(result.text, result.sessionId));
}

async function runImageTask({ msg, scope, prompt, signal }) {
  const previousSessionId = sessions.get(scope);
  const startedAt = Date.now();
  await ensureImageOutputDir(config.imageOutputDir);

  console.log(`[codex] ${scope} start type=image resume=${previousSessionId ? "yes" : "no"} queue=${queued.get(scope) ?? 0}`);
  const result = await runCodex({
    prompt: buildCodexImagePrompt({ userPrompt: prompt, outputDir: config.imageOutputDir }),
    sessionId: previousSessionId,
    workdir: config.workdir,
    sandbox: config.sandbox,
    model: config.model,
    timeoutMs: config.imageTimeoutMs,
    signal
  });
  if (result.sessionId) sessions.set(scope, result.sessionId);

  const imageResult = await resolveImageResult({
    text: result.text,
    outputDir: config.imageOutputDir,
    workdir: config.workdir,
    sinceMs: startedAt,
    maxBytes: config.imageMaxBytes
  });

  if (!imageResult.path) {
    const detail = imageResult.errors.length ? `\n\n图片候选校验失败：\n\`\`\`\n${clip(imageResult.errors.join("\n"), 1800)}\n\`\`\`` : "";
    console.warn(`[codex] ${scope} image done without uploadable file`);
    await sendMarkdown(
      msg,
      withCodexFooter(`Codex 完成了图片任务，但没有找到可上传的图片文件。\n\n${result.text}${detail}`, result.sessionId)
    );
    return;
  }

  console.log(`[codex] ${scope} done type=image session=${result.sessionId ?? "-"} image=${imageResult.path}`);
  await sendImageReply(msg, imageResult.path);

  const caption = cleanImageCaption(result.text);
  await sendMarkdown(
    msg,
    withCodexFooter(caption ? `图片已生成并上传。\n\n${caption}` : "图片已生成并上传。", result.sessionId)
  );
}

function withCodexFooter(text, sessionId) {
  const shortSession = sessionId ? ` · session ${sessionId.slice(0, 8)}` : "";
  return `${text.trim()}\n\n---\nCodex${shortSession}`;
}

function enqueue(scope, task) {
  const previous = chains.get(scope) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(async () => {
      running.add(scope);
      try {
        await task();
      } finally {
        running.delete(scope);
      }
    });
  chains.set(scope, current);
  current
    .finally(() => {
      if (chains.get(scope) === current) chains.delete(scope);
    })
    .catch(() => {});
  return current;
}

function normalizeMessageText(msg) {
  const raw = typeof msg.content === "string" ? msg.content : "";
  return stripBotMention(raw, msg).trim();
}

function stripBotMention(text, msg) {
  let out = text;
  const identity = channel.botIdentity;
  const candidates = [
    identity?.name,
    identity?.openId,
    ...(Array.isArray(msg.mentions)
      ? msg.mentions.flatMap((m) => [m?.name, m?.id?.open_id, m?.id?.user_id, m?.key])
      : [])
  ]
    .filter((v) => typeof v === "string" && v.length > 0)
    .map(escapeRegExp);

  for (const value of candidates) {
    out = out.replace(new RegExp(`^\\s*@?${value}\\s*`, "i"), "");
  }
  return out.replace(/^<at[^>]*>.*?<\/at>\s*/i, "");
}

async function sendMarkdown(msg, markdown) {
  const options = { replyTo: msg.messageId };
  if (msg.threadId) options.replyInThread = true;
  await channel.send(msg.chatId, { markdown: clip(markdown, 12000) }, options);
}

async function sendImageReply(msg, imagePath) {
  const uploaded = await larkClient.im.v1.image.create({
    data: {
      image_type: "message",
      image: createReadStream(imagePath)
    }
  });
  const imageKey = uploaded?.image_key;
  if (!imageKey) throw new Error("Feishu image upload returned no image_key");

  await larkClient.im.v1.message.reply({
    path: {
      message_id: msg.messageId
    },
    data: {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
      reply_in_thread: Boolean(msg.threadId)
    }
  });
}

function statusText(scope) {
  const sessionId = sessions.get(scope);
  const queueSize = queued.get(scope) ?? 0;
  return [
    "**Codex Feishu Bridge**",
    "",
    `workdir: \`${escapeMd(config.workdir)}\``,
    `codex: \`${escapeMd(codexVersion)}\``,
    `session: ${sessionId ? `\`${escapeMd(sessionId)}\`` : "(none)"}`,
    `running: \`${running.has(scope) ? "yes" : "no"}\``,
    `queued: \`${queueSize}\``,
    `sandbox: \`${escapeMd(config.sandbox)}\``,
    `image_output_dir: \`${escapeMd(config.imageOutputDir)}\``,
    `image_max_bytes: \`${config.imageMaxBytes}\``
  ].join("\n");
}

function abortActive(scope) {
  const controller = activeControllers.get(scope);
  if (controller) controller.abort();
}

function incrementQueue(scope) {
  const next = (queued.get(scope) ?? 0) + 1;
  queued.set(scope, next);
  return next;
}

function decrementQueue(scope) {
  const next = Math.max(0, (queued.get(scope) ?? 0) - 1);
  if (next === 0) queued.delete(scope);
  else queued.set(scope, next);
}

async function shutdown(reason) {
  console.log(`\nReceived ${reason}; shutting down...`);
  for (const controller of activeControllers.values()) controller.abort();
  try {
    await channel.disconnect();
  } catch (err) {
    console.warn("[shutdown] disconnect failed:", err?.message ?? String(err));
  }
  await sessions.flush();
  process.exit(0);
}

function readConfig() {
  const appId = requiredEnv("FEISHU_APP_ID");
  const appSecret = requiredEnv("FEISHU_APP_SECRET");
  const domain = (process.env.FEISHU_DOMAIN || "feishu").trim().toLowerCase();
  if (domain !== "feishu" && domain !== "lark") {
    throw new Error("FEISHU_DOMAIN must be either 'feishu' or 'lark'");
  }

  return {
    appId,
    appSecret,
    domain,
    workdir: process.env.CODEX_WORKDIR || "/Users/tangsijie/Documents/agenttest",
    sandbox: process.env.CODEX_SANDBOX || "workspace-write",
    model: process.env.CODEX_MODEL || "",
    timeoutMs: parsePositiveInt(process.env.CODEX_TIMEOUT_MS, 900000),
    imageOutputDir: resolveFromBridgeRoot(process.env.IMAGE_OUTPUT_DIR || "generated"),
    imageTimeoutMs: parsePositiveInt(process.env.IMAGE_TIMEOUT_MS, 900000),
    imageMaxBytes: parsePositiveInt(process.env.IMAGE_MAX_BYTES, 10485760),
    requireMentionInGroup: parseBool(process.env.REQUIRE_MENTION_IN_GROUP, true)
  };
}

function resolveFromBridgeRoot(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(bridgeRoot, value);
}

function requiredEnv(name) {
  const value = process.env[name] || launchctlGetenv(name);
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function launchctlGetenv(name) {
  if (process.platform !== "darwin") return "";
  const result = spawnSync("launchctl", ["getenv", name], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function parseBool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|y)$/i.test(value);
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clip(text, max) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 20)}\n...(truncated)`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMd(text) {
  return String(text).replace(/([`\\])/g, "\\$1");
}
