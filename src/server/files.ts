/**
 * ============================================================
 * files.ts — 文件上下文：项目文件夹 / 远程文件夹 / 本地上传
 * ============================================================
 * 三种给 Agent 附加文件的来源：
 *   1. 项目文件夹    —— 服务端仓库根目录（默认授权），可浏览/选择
 *   2. 远程文件夹    —— Web 是 B/S 架构，服务器即「远程」：
 *                      用户输入服务器上的绝对路径，显式授权后可浏览。
 *                      ⚠ 这会把该目录暴露给网页端，仅适合本地/可信环境
 *   3. 本地上传      —— 云端部署时服务器没有用户的本机文件，
 *                      浏览器选文本文件上传到内存暂存区（重启即失）
 *
 * 安全设计：
 *   - 浏览/读取只允许「已授权根」之内：resolve 后做前缀校验（win32 忽略大小写）；
 *   - 列目录跳过 node_modules / .git / dist；
 *   - 上传仅支持文本（检测 \0），有字符数上限，暂存区有容量上限（LRU 淘汰）；
 *   - 发送时服务端读取文件内容并拼进用户消息（单文件超长截断），
 *     前端只传「引用」，不传内容 —— 保证附件内容始终经过授权校验。
 */
import { promises as fsp } from "node:fs";
import { join, resolve, basename, dirname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
export { PROJECT_ROOT };
export const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", ".setting", ".playwright-mcp"]);
const MAX_LIST_ENTRIES = 2000;
const MAX_READ_CHARS = 300_000;    // /api/fs/read 单文件上限
const MAX_UPLOAD_CHARS = 400_000;  // 上传单文件上限（字符）
const MAX_UPLOAD_FILES = 40;       // 暂存区文件数（LRU）
const MAX_ATTACH_FILES = 5;        // 单条消息最多附加文件数
const MAX_ATTACH_CHARS = 100_000;  // 发送时单文件截断阈值

/** 已授权的可浏览根：绝对路径 → 显示名 */
const authorizedRoots = new Map<string, string>([[PROJECT_ROOT, "项目根"]]);

// ---------------------------------------------------------------------------
// 路径授权
// ---------------------------------------------------------------------------
function samePrefix(child: string, root: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const c = norm(child);
  const r = norm(root);
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

function assertAuthorized(absPath: string): void {
  for (const root of authorizedRoots.keys()) {
    if (samePrefix(absPath, root)) return;
  }
  throw new Error("路径未授权：只能浏览项目根或已添加的远程文件夹");
}
export { assertAuthorized };

export function listRoots(): Array<{ path: string; name: string }> {
  return [...authorizedRoots.entries()].map(([path, name]) => ({ path, name }));
}

/** 注册一个可浏览根（项目管理/云端文件夹用）；返回是否为新授权 */
export function authorizeRoot(path: string, name: string): boolean {
  const p = resolve(path);
  if (authorizedRoots.has(p)) return false;
  authorizedRoots.set(p, name);
  return true;
}

/** 撤销一个可浏览根（删除项目时） */
export function unauthorizeRoot(path: string): void {
  authorizedRoots.delete(resolve(path));
}

/** 授权一个服务器上的文件夹作为可浏览根（「远程文件夹」功能） */
export async function openRemoteRoot(rawPath: string): Promise<{ path: string; name: string }> {
  const p = resolve(rawPath.trim());
  if (!p) throw new Error("路径不能为空");
  const st = await fsp.stat(p).catch(() => { throw new Error("路径不存在"); });
  if (!st.isDirectory()) throw new Error("该路径不是文件夹");
  if (!authorizedRoots.has(p)) {
    if (authorizedRoots.size >= 12) throw new Error("已授权文件夹数量达上限（12 个）");
    authorizedRoots.set(p, basename(p) || p);
  }
  return { path: p, name: basename(p) || p };
}

// ---------------------------------------------------------------------------
// 目录浏览
// ---------------------------------------------------------------------------
export interface FsEntry { name: string; type: "dir" | "file"; size: number }

export async function listDir(rawPath?: string): Promise<{
  path: string;
  name: string;
  parent: string | null;
  roots: Array<{ path: string; name: string }>;
  entries: FsEntry[];
}> {
  const target = resolve(rawPath?.trim() || PROJECT_ROOT);
  assertAuthorized(target);
  const st = await fsp.stat(target).catch(() => { throw new Error("路径不存在"); });
  if (!st.isDirectory()) throw new Error("该路径不是文件夹");

  const dirents = await fsp.readdir(target, { withFileTypes: true })
    .catch((e: Error) => { throw new Error("无法读取目录：" + e.message); });

  const entries: FsEntry[] = [];
  for (const d of dirents) {
    if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
    let size = 0;
    if (d.isFile()) {
      size = await fsp.stat(join(target, d.name)).then((s) => s.size).catch(() => 0);
    }
    entries.push({ name: d.name, type: d.isDirectory() ? "dir" : "file", size });
    if (entries.length >= MAX_LIST_ENTRIES) break;
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));

  const rootOf = [...authorizedRoots.keys()].find((r) => samePrefix(target, r));
  const parent = rootOf && target !== rootOf ? dirname(target) : null;
  return {
    path: target,
    name: basename(target) || target,
    parent,
    roots: listRoots(),
    entries,
  };
}

// ---------------------------------------------------------------------------
// 文件读取（发送前由服务端执行，前端只传引用）
// ---------------------------------------------------------------------------
export interface FileContent {
  name: string;
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

export async function readFileAuthorized(rawPath: string): Promise<FileContent> {
  const p = resolve(rawPath.trim());
  assertAuthorized(p);
  const st = await fsp.stat(p).catch(() => { throw new Error("文件不存在"); });
  if (st.isDirectory()) throw new Error("这是一个文件夹，请选择文件");
  const buf = await fsp.readFile(p);
  if (buf.subarray(0, 8000).includes(0)) {
    return { name: basename(p), content: "", truncated: false, size: st.size, binary: true };
  }
  const content = buf.toString("utf8");
  const truncated = content.length > MAX_READ_CHARS;
  return {
    name: basename(p),
    content: truncated ? content.slice(0, MAX_READ_CHARS) : content,
    truncated,
    size: st.size,
    binary: false,
  };
}

// ---------------------------------------------------------------------------
// 本地上传（云端部署场景：服务器没有用户的本机文件）
// 支持文本文件（读内容）与图片（dataURL，多模态模型可用）
// ---------------------------------------------------------------------------
export interface StoredUpload {
  name: string;
  kind: "text" | "image";
  /** text = 文件文本；image = dataURL（data:image/...;base64,…） */
  content: string;
  size: number;
  at: number;
}

const uploads = new Map<string, StoredUpload>();

const MAX_UPLOAD_IMAGE_CHARS = 6_000_000; // 图片 dataURL 上限（约 4.5MB 原图）

/** 保存上传：image=true 时 content 为 dataURL（多模态模型可消费） */
export function storeUpload(name: string, content: string, image = false): { id: string; name: string; size: number; kind: "text" | "image" } {
  const kind: "text" | "image" = image ? "image" : "text";
  if (kind === "image") {
    if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/.test(content)) {
      throw new Error("图片上传内容必须是 dataURL（data:image/...;base64,…）");
    }
    if (content.length > MAX_UPLOAD_IMAGE_CHARS) {
      throw new Error(`图片过大（超过约 4.5MB）`);
    }
  } else {
    if (content.includes("\0")) throw new Error("不支持二进制文件，请上传文本文件（.md/.ts/.json/…）或图片");
    if (!content.length) throw new Error("文件内容为空");
    if (content.length > MAX_UPLOAD_CHARS) {
      throw new Error(`文件过大（超过 ${Math.round(MAX_UPLOAD_CHARS / 1000)}k 字符）`);
    }
  }
  const id = randomUUID();
  uploads.set(id, { name, kind, content, size: content.length, at: Date.now() });
  while (uploads.size > MAX_UPLOAD_FILES) {
    const oldest = [...uploads.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!oldest) break;
    uploads.delete(oldest[0]);
  }
  return { id, name, size: content.length, kind };
}

export function getUpload(id: string): StoredUpload | undefined {
  return uploads.get(id);
}

// ---------------------------------------------------------------------------
// 发送组装：把附件内容拼进用户消息（供 4 个 Demo 的图与 mock 共用）
// ---------------------------------------------------------------------------
export interface ChatFileRef { kind?: string; path?: string; uploadId?: string; name?: string }
export interface ResolvedFile { name: string; kind: "text" | "image"; content: string; truncated: boolean }

function truncateForChat(name: string, content: string, kind: "text" | "image" = "text"): ResolvedFile {
  if (content.length <= MAX_ATTACH_CHARS) return { name, content, truncated: false, kind };
  return {
    name,
    content: content.slice(0, MAX_ATTACH_CHARS) + `\n\n…（文件过长已截断，原始 ${content.length} 字符）`,
    truncated: true,
    kind,
  };
}

/**
 * 解析聊天里的文件引用 → 实际内容；任何无效引用抛错（路由层转 400）。
 * allowImages=false（纯文本模型）时图片引用会抛错，由前端提示改用多模态模型。
 */
export async function resolveChatFiles(refs: ChatFileRef[], allowImages: boolean): Promise<ResolvedFile[]> {
  const out: ResolvedFile[] = [];
  for (const ref of refs.slice(0, MAX_ATTACH_FILES)) {
    if (ref && ref.kind === "upload" && ref.uploadId) {
      const up = getUpload(ref.uploadId);
      if (!up) throw new Error(`上传的文件「${ref.name || ref.uploadId}」已过期（服务重启会清空，请重新上传）`);
      if (up.kind === "image") {
        if (!allowImages) {
          throw new Error(`「${up.name}」是图片，当前启用的模型不支持多模态 —— 请在 ⚙ 设置里把该模型的「多模态」勾上，或改用文本附件`);
        }
        out.push({ name: up.name, kind: "image", content: up.content, truncated: false });
      } else {
        out.push(truncateForChat(up.name, up.content, "text"));
      }
    } else if (ref && ref.kind === "fs" && ref.path) {
      const f = await readFileAuthorized(ref.path);
      if (f.binary) throw new Error(`「${ref.name || f.name}」是二进制文件，暂不支持附加`);
      out.push(truncateForChat(ref.name || f.name, f.content, "text"));
    } else {
      throw new Error("无效的文件引用");
    }
  }
  return out;
}

/** 附件拼进消息后的文本部分（多模态时配合 image parts 一起发送） */
export function assembleMessageWithFiles(message: string, files: ResolvedFile[]): string {
  const textFiles = files.filter((f) => f.kind === "text");
  const imageNames = files.filter((f) => f.kind === "image").map((f) => f.name);
  const header: string[] = [];
  if (textFiles.length) {
    const blocks = textFiles.map((f, i) =>
      `--- 附件 ${i + 1}: ${f.name}${f.truncated ? "（超长已截断）" : ""} ---\n${f.content}\n--- 附件 ${i + 1} 结束 ---`
    );
    header.push(`【用户附加了以下 ${textFiles.length} 个文件，回答时请参考其内容】\n${blocks.join("\n\n")}`);
  }
  if (imageNames.length) {
    header.push(`【用户附加了 ${imageNames.length} 张图片：${imageNames.join("、")}（见消息中的图片输入）】`);
  }
  if (!header.length) return message;
  return `${header.join("\n\n")}\n\n【用户消息】${message}`;
}

/**
 * 组装 HumanMessage 的内容：
 *  - 纯文本附件 / 纯文本模型 → 字符串；
 *  - 有图片且模型多模态 → 内容块数组（text + image_url dataURL，OpenAI 兼容格式）。
 */
export function buildUserContent(
  message: string,
  files: ResolvedFile[],
  modality: "text" | "vision"
): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const text = assembleMessageWithFiles(message, files);
  const images = files.filter((f) => f.kind === "image");
  if (modality !== "vision" || !images.length) return text;
  return [
    { type: "text", text },
    ...images.map((f) => ({ type: "image_url" as const, image_url: { url: f.content } })),
  ];
}
