/**
 * ============================================================
 * projects.ts — 项目文件夹管理（本地 / 云端）
 * ============================================================
 * 参考 ZCode 的「项目 ▾」：会话按所属项目文件夹分组，新建对话归属当前项目。
 * 项目文件夹分两类，UI 用不同样式区分：
 *
 *   - local（💻 本地）：服务器磁盘上的目录。内置默认项目 = 本仓库根；
 *     也可添加服务器上的其他绝对路径。
 *   - cloud（☁️ 云端）：一个 Git 仓库地址（https://… .git）。
 *     添加时自动 `git clone --depth 1` 到本地缓存（.setting/cloud/<名称>），
 *     之后浏览 / 附加文件与本地项目完全一致；「刷新」= git pull。
 *
 * 持久化：.web-config.json 的 { projects, activeProjectId } 字段
 * （与 providers 同文件，各自读改写）。
 */
import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { resolve, basename, join } from "node:path";
import { PROJECT_ROOT, authorizeRoot, unauthorizeRoot } from "./files.js";
import { SETTINGS_FILE, mergeConfig, readConfig } from "./config-store.js";

const run = promisify(execFile);
const CLOUD_DIR = join(PROJECT_ROOT, ".setting", "cloud");
const MAX_PROJECTS = 12;

export interface Project {
  id: string;
  name: string;
  type: "local" | "cloud";
  /** 可浏览的根目录（cloud = 本地 clone 缓存目录） */
  path: string;
  /** cloud 类型的仓库地址 */
  url?: string;
  /** 内置默认项目不可删除 */
  builtin?: boolean;
}

let projects: Project[] = [];
let activeProjectId = "default";

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------
async function persist(): Promise<void> {
  // merge 写入：只覆盖 projects/activeProjectId，不碰同文件的 providers / externalAgents 等键
  await mergeConfig({ projects, activeProjectId });
}

export async function loadProjects(): Promise<void> {
  const saved = await readConfig();

  const defaultProject: Project = {
    id: "default",
    name: "learn-agent",
    type: "local",
    path: PROJECT_ROOT,
    builtin: true,
  };
  authorizeRoot(PROJECT_ROOT, defaultProject.name);

  const savedList = (Array.isArray(saved?.projects)
    ? (saved!.projects as Array<Partial<Project>>)
    : []
  ).filter((p): p is Project =>
    Boolean(p && p.id && typeof p.path === "string" && (p.type === "local" || p.type === "cloud"))
  );

  projects = [defaultProject];
  for (const p of savedList) {
    if (p.id === "default") continue;
    // 磁盘目录仍在才恢复（云端 clone 缓存可能被手动删除）
    const exists = await fsp.stat(p.path).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) continue;
    projects.push({
      id: p.id!,
      name: p.name || "未命名项目",
      type: p.type!,
      path: resolve(p.path),
      url: typeof p.url === "string" ? p.url : undefined,
    });
    authorizeRoot(p.path, p.name || "未命名项目");
  }
  activeProjectId =
    typeof saved?.activeProjectId === "string" && projects.some((p) => p.id === saved!.activeProjectId)
      ? (saved!.activeProjectId as string)
      : "default";
}

// ---------------------------------------------------------------------------
// 查询 / 切换
// ---------------------------------------------------------------------------
export function listProjects(): Project[] {
  return projects;
}

export function getActiveProjectId(): string {
  return activeProjectId;
}

export function getProject(id: string): Project | undefined {
  return projects.find((p) => p.id === id);
}

export function setActiveProject(id: string): void {
  if (!projects.some((p) => p.id === id)) throw new Error("项目不存在");
  activeProjectId = id;
  void persist().catch(() => {});
}

// ---------------------------------------------------------------------------
// 添加（本地路径 / 云端 Git 仓库）
// ---------------------------------------------------------------------------
function slugFromUrl(url: string): string {
  const tail = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return tail.replace(/[^\w.-]+/g, "-").slice(0, 48) || "repo";
}

export async function addProject(input: {
  name?: string;
  type?: string;
  path?: string;
  url?: string;
}): Promise<Project> {
  if (projects.length >= MAX_PROJECTS) throw new Error(`项目数量已达上限（${MAX_PROJECTS} 个）`);
  const type = input.type === "cloud" ? "cloud" : "local";

  if (type === "local") {
    if (!input.path?.trim()) throw new Error("请填写服务器上的文件夹绝对路径");
    const path = resolve(input.path.trim());
    const st = await fsp.stat(path).catch(() => { throw new Error("路径不存在"); });
    if (!st.isDirectory()) throw new Error("该路径不是文件夹");
    if (projects.some((p) => resolve(p.path) === path)) throw new Error("该文件夹已添加过");
    const name = input.name?.trim() || basename(path) || path;
    const project: Project = { id: randomUUID(), name, type: "local", path };
    projects.push(project);
    authorizeRoot(path, name);
    await persist();
    return project;
  }

  // ── 云端：git clone --depth 1 到本地缓存 ──
  const url = input.url?.trim() ?? "";
  if (!/^(https?:\/\/\S+|git@[\w.-]+:\S+)$/.test(url)) {
    throw new Error("请填写合法的 Git 仓库地址（https://…/xxx.git 或 git@…）");
  }
  const name = input.name?.trim() || slugFromUrl(url);
  if (projects.some((p) => p.url === url)) throw new Error("该仓库已添加过");
  await fsp.mkdir(CLOUD_DIR, { recursive: true });
  const target = join(CLOUD_DIR, `${name}-${randomUUID().slice(0, 6)}`);
  try {
    await run("git", ["clone", "--depth", "1", url, target], { timeout: 120_000 });
  } catch (err) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone 失败（确认已安装 git、有网络与仓库权限）：${msg.slice(0, 160)}`);
  }
  const project: Project = { id: randomUUID(), name, type: "cloud", path: target, url };
  projects.push(project);
  authorizeRoot(target, name);
  await persist();
  return project;
}

/** 云端项目：git pull 刷新缓存 */
export async function refreshCloudProject(id: string): Promise<Project> {
  const p = getProjectChecked(id);
  if (p.type !== "cloud") throw new Error("只有云端项目支持刷新（本地目录即最新）");
  await run("git", ["-C", p.path, "pull", "--ff-only"], { timeout: 120_000 });
  return p;
}

/** 删除项目：内置不可删；云端同时清理 clone 缓存；其会话由调用方迁移到默认项目 */
export async function deleteProject(id: string): Promise<void> {
  const p = getProjectChecked(id);
  if (p.builtin) throw new Error("内置项目（本仓库）不可删除");
  unauthorizeRoot(p.path);
  if (p.type === "cloud") {
    await fsp.rm(p.path, { recursive: true, force: true }).catch(() => {});
  }
  projects = projects.filter((x) => x.id !== id);
  if (activeProjectId === id) activeProjectId = "default";
  await persist();
}

function getProjectChecked(id: string): Project {
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error("项目不存在");
  return p;
}
