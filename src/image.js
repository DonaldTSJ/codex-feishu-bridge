import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export function parseImageCommand(text) {
  const source = String(text ?? "").trim();
  const patterns = [
    /^\/(?:image|img|draw)(?:\s+|$)([\s\S]*)$/i,
    /^(?:生图|画图|画一张|生成图片|生成一张图)(?:[：:\s]+)?([\s\S]*)$/i
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    const prompt = match?.[1]?.trim();
    if (prompt) return { prompt };
  }

  return null;
}

export async function ensureImageOutputDir(outputDir) {
  await mkdir(outputDir, { recursive: true });
}

export function buildCodexImagePrompt({ userPrompt, outputDir }) {
  return [
    "You are handling an image request that came from a Feishu/Lark bot.",
    "",
    "Goal:",
    "- Create or obtain one real raster image file for the user's request.",
    "- If an actual image-generation tool or model is available in your Codex environment, use it.",
    "- If no image-generation tool is available, create a useful local raster image with code or other available local tools.",
    "- Do not claim that a specific model or API was used unless you actually used it.",
    "- Do not return only a remote URL. The bridge can upload only a local image file.",
    "",
    "Output requirements:",
    `- Save the image under this directory: ${outputDir}`,
    "- Use png, jpg, jpeg, webp, or gif.",
    "- Keep the file under 10 MB.",
    "- In your final answer, include a line exactly like: IMAGE_PATH: <absolute path to the image file>",
    "- Optionally include a short CAPTION line after that.",
    "",
    "User image request:",
    userPrompt
  ].join("\n");
}

export async function resolveImageResult({ text, outputDir, workdir, sinceMs, maxBytes }) {
  const candidates = [];
  for (const candidate of extractImagePathCandidates(text)) {
    candidates.push({ path: candidate, source: "codex-final" });
  }
  for (const recent of await listRecentImages(outputDir, sinceMs)) {
    candidates.push({ path: recent, source: "output-dir" });
  }

  const seen = new Set();
  const errors = [];
  for (const candidate of candidates) {
    const absolutePath = resolveCandidatePath(candidate.path, { outputDir, workdir });
    if (!absolutePath || seen.has(absolutePath)) continue;
    seen.add(absolutePath);

    try {
      const validatedPath = await validateImagePath(absolutePath, { outputDir, workdir, maxBytes });
      return { path: validatedPath, source: candidate.source };
    } catch (err) {
      errors.push(err?.message ?? String(err));
    }
  }

  return { path: "", source: "", errors };
}

export function cleanImageCaption(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^IMAGE_PATH\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
}

function extractImagePathCandidates(text) {
  const candidates = [];
  const source = String(text ?? "");

  for (const match of source.matchAll(/^IMAGE_PATH\s*:\s*(.+)$/gim)) {
    candidates.push(cleanCandidate(match[1]));
  }
  for (const match of source.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)) {
    candidates.push(cleanCandidate(match[1]));
  }

  return candidates.filter(Boolean);
}

function cleanCandidate(value) {
  let out = String(value ?? "").trim();
  if (!out) return "";
  if (/^https?:\/\//i.test(out)) return "";
  if (out.startsWith("<") && out.endsWith(">")) out = out.slice(1, -1).trim();
  out = out.replace(/^file:\/\//i, "file://");
  if (out.startsWith("file://")) {
    try {
      out = fileURLToPath(out);
    } catch {
      return "";
    }
  }
  out = out.replace(/^['"`]+|['"`]+$/g, "");
  out = out.replace(/[),.;]+$/g, "");
  return out.trim();
}

function resolveCandidatePath(candidate, { outputDir, workdir }) {
  if (!candidate) return "";
  const value = path.normalize(candidate);
  if (path.isAbsolute(value)) return path.resolve(value);

  const fromWorkdir = path.resolve(workdir, value);
  if (existsSync(fromWorkdir)) return fromWorkdir;

  return path.resolve(outputDir, value);
}

async function validateImagePath(imagePath, { outputDir, workdir, maxBytes }) {
  const absolutePath = path.resolve(imagePath);
  const allowedRoots = [path.resolve(workdir), path.resolve(outputDir)];
  if (!allowedRoots.some((root) => isInside(absolutePath, root))) {
    throw new Error(`image path is outside allowed directories: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported image extension: ${ext || "(none)"}`);
  }

  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`image path is not a file: ${absolutePath}`);
  if (info.size <= 0) throw new Error(`image file is empty: ${absolutePath}`);
  if (info.size > maxBytes) {
    throw new Error(`image file is too large: ${info.size} bytes > ${maxBytes} bytes`);
  }

  return absolutePath;
}

async function listRecentImages(outputDir, sinceMs) {
  if (!existsSync(outputDir)) return [];
  const results = [];
  await collectImages(outputDir, sinceMs - 5000, 2, results);
  return results
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((item) => item.path);
}

async function collectImages(dir, minMtimeMs, depth, results) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) await collectImages(fullPath, minMtimeMs, depth - 1, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const info = await stat(fullPath).catch(() => null);
    if (info && info.mtimeMs >= minMtimeMs) {
      results.push({ path: fullPath, mtimeMs: info.mtimeMs });
    }
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
