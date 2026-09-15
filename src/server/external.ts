/**
 * ============================================================
 * external.ts — 第三方 Agent 接入（只需要一个 Git 仓库地址）
 * ============================================================
 * 场景：像 deepseek-harness 这样的第三方 agent 工具，想接入本工作台
 * 不用改代码 —— 提供它的 Git 地址即可：
 *
 *   1. 服务端 `git clone --depth 1` 到 .setting/agents/<名称>-<id>；
 *   2. 自动发现「怎么运行它」，优先级：
 *      ① 仓库根的 agent.json 清单（推荐约定，见下方 MANIFEST）；
 *      ② package.json 的 bin / main 字段（Node 类工具）；
 *      ③ 根目录常见入口（cli.js / index.js / agent.py / main.py …）；
 *      ③ 都没有 → 注册为「待补全」，由用户在 UI 里补一条启动命令。
 *   3. 注册后出现在「新建对话」弹窗，选中即创建外部会话；
 *   4. 每条消息 = 启动一次子进程：启动命令的 stdout 按块流式转成
 *      AgentEvent.token 推给前端，非 0 退出把 stderr 尾部作为错误展示。
 *
 * MANIFEST（agent.json，仓库根）：
 *   {
 *     "name": "my-agent",              // 展示名（可选，缺省取仓库名）
 *     "description": "一句话介绍",      // 可选
 *     "command": "node",               // 必填：可执行文件
 *     "args": ["agent.js", "{{prompt}}"], // 可选：{{prompt}} 会替换成用户消息；
 *     "env": { "KEY": "value" },       // 可选：附加环境变量
 *     "passCredentials": false          // 可选：true 时注入本工作台的网关配置
 *   }                                    （AGENT_API_KEY / AGENT_BASE_URL /
 *                                         AGENT_MODEL + OPENAI_* 同名变量）
 * 没有占位符时，用户消息从 stdin 写入（一行 JSON：{"message":"..."}）。
 *
 * 安全须知：接入 = 在服务器上运行第三方代码，请只添加可信仓库；
 * 网关 API Key 仅在 passCredentials=true 时注入，默认不传。
 */
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig, readConfig } from "./config-store.js";
import { PROJECT_ROOT } from "./files.js";
import { config } from "../config.js";
import type { AgentEvent } from "./events.js";

const run = promisify(execFile);
const AGENTS_DIR = join(PROJECT_ROOT, ".setting", "agents");
const RUN_TIMEOUT_MS = 180_000;
const MAX_AGENTS = 12;

export interface ExternalAgent {
  id: string;
  name: string;
  description?: string;
  /** 仓库 Git 地址 */
  url: string;
  /** 本地 clone 缓存目录（运行时 cwd） */
  path: string;
  /** 启动命令（如 node / python / bash），空串 = 待补全 */
  command: string;
  /** 启动参数；含 {{prompt}} 占位符时替换为用户消息，否则消息走 stdin */
  args: string[];
  /** 附加环境变量 */
  env?: Record<string, string>;
  /** true 时把当前启用供应商的网关配置注入子进程环境 */
  passCredentials?: boolean;
  /** 命令是自动发现（而非清单/手填）的标记，UI 提示可修正 */
  discovered?: boolean;
  createdAt: number;
}

let agents: ExternalAgent[] = [];

// ---------------------------------------------------------------------------
// 持久化 / 启动加载
// ---------------------------------------------------------------------------
async function persist(): Promise<void> {
  await mergeConfig({ externalAgents: agents });
}

export async function loadExternalAgents(): Promise<void> {
  const saved = await readConfig();
  const list = Array.isArray(saved.externalAgents) ? (saved.externalAgents as Array<Partial<ExternalAgent>>) : [];
  const kept: ExternalAgent[] = [];
  for (const a of list) {
    if (!a || typeof a.url !== "string" || typeof a.path !== "string") continue;
    // clone 缓存目录被手动删掉 → 丢弃注册（与云端项目同策略）
    const exists = await fsp.stat(a.path).then((s) => s.isDirectory()).catch(() => false);
    if (!exists) continue;
    kept.push(normalize(a));
  }
  agents = kept;
}

function normalize(a: Partial<ExternalAgent>): ExternalAgent {
  return {
    id: a.id || randomUUID(),
    name: (a.name || "未命名 Agent").trim(),
    description: typeof a.description === "string" ? a.description : undefined,
    url: a.url!,
    path: resolve(a.path!),
    command: typeof a.command === "string" ? a.command.trim() : "",
    args: Array.isArray(a.args) ? a.args.map(String) : [],
    env: a.env && typeof a.env === "object" ? Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)])) : undefined,
    passCredentials: a.passCredentials === true,
    discovered: a.discovered === true,
    createdAt: typeof a.createdAt === "number" ? a.createdAt : Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------
export function listExternalAgents(): ExternalAgent[] {
  return agents;
}

export function getExternalAgent(id: string): ExternalAgent | undefined {
  return agents.find((a) => a.id === id);
}

// ---------------------------------------------------------------------------
// 接入：clone + 发现 + 注册
// ---------------------------------------------------------------------------
const GIT_URL_RE = /^(https?:\/\/\S+|git@[\w.-]+:\S+|file:\/\/\S+)$/;

function slugFromUrl(url: string): string {
  const tail = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "repo";
  return tail.replace(/[^\w.-]+/g, "-").slice(0, 48) || "repo";
}

async function cloneRepo(url: string, target: string): Promise<void> {
  await fsp.mkdir(AGENTS_DIR, { recursive: true });
  try {
    await run("git", ["clone", "--depth", "1", url, target], { timeout: 120_000 });
  } catch (err) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git clone 失败（确认已安装 git、有网络与仓库权限）：${msg.slice(0, 160)}`);
  }
}

/** agent.json 清单（宽松解析：只认得出的字段生效） */
async function readManifest(dir: string): Promise<Partial<ExternalAgent> | null> {
  for (const f of ["agent.json", ".agent.json"]) {
    try {
      const raw = JSON.parse(await fsp.readFile(join(dir, f), "utf8"));
      if (raw && typeof raw === "object" && typeof (raw as { command?: unknown }).command === "string") {
        return raw as Partial<ExternalAgent>;
      }
    } catch { /* 没有清单或格式不对 → 走启发式 */ }
  }
  return null;
}

/** 无清单时的启发式：package.json bin/main / 常见入口文件 */
async function guessCommand(dir: string): Promise<{ command: string; args: string[] } | null> {
  const exists = (p: string) => fsp.stat(join(dir, p)).then(() => true).catch(() => false);

  try {
    const pkg = JSON.parse(await fsp.readFile(join(dir, "package.json"), "utf8")) as {
      bin?: string | Record<string, string>; main?: string;
    };
    if (pkg.bin) {
      const binPath = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin)[0];
      if (binPath && await exists(binPath)) return { command: "node", args: [binPath, "{{prompt}}"] };
    }
    if (pkg.main && await exists(pkg.main)) return { command: "node", args: [pkg.main, "{{prompt}}"] };
  } catch { /* 非 npm 包 → 继续 */ }

  for (const f of ["cli.js", "cli.mjs", "index.js", "main.js", "run.js", "agent.js"]) {
    if (await exists(f)) return { command: "node", args: [f, "{{prompt}}"] };
  }
  for (const f of ["agent.py", "cli.py", "main.py", "run.py"]) {
    if (await exists(f)) return { command: "python", args: [f, "{{prompt}}"] };
  }
  return null;
}

export async function addExternalAgent(input: {
  url?: string; name?: string; command?: string; args?: unknown; passCredentials?: unknown;
}): Promise<{ agent: ExternalAgent; discovered: boolean; hint: string }> {
  if (agents.length >= MAX_AGENTS) throw new Error(`外部 Agent 数量已达上限（${MAX_AGENTS} 个）`);
  const url = input.url?.trim() ?? "";
  if (!GIT_URL_RE.test(url)) {
    throw new Error("请填写合法的 Git 仓库地址（https://…/xxx 或 git@… 或 file:///…）");
  }
  const existing = agents.find((a) => a.url === url);
  if (existing) throw new Error(`该仓库已接入过（「${existing.name}」）`);

  // clone
  const name = input.name?.trim() || slugFromUrl(url);
  const target = join(AGENTS_DIR, `${name}-${randomUUID().slice(0, 6)}`);
  await cloneRepo(url, target);

  // 发现运行方式：外部显式给的命令 > 清单 > 启发式 > 待补全
  let discovered = false;
  let hint = "";
  let command = input.command?.trim() ?? "";
  let args: string[] = Array.isArray(input.args) ? (input.args as unknown[]).map(String) : [];
  if (!command) {
    const manifest = await readManifest(target);
    if (manifest?.command) {
      command = manifest.command.trim();
      args = Array.isArray(manifest.args) ? (manifest.args as unknown[]).map(String) : args;
      if (manifest.name?.trim()) hint = manifest.name.trim();
      discovered = true;
    } else {
      const guess = await guessCommand(target);
      if (guess) {
        command = guess.command;
        args = guess.args;
        discovered = true;
        hint = "已按仓库结构自动推测启动命令，若运行不对可删除后手动指定";
      }
    }
  }
  const manifest = command ? (await readManifest(target)) ?? {} : {};
  const agent = normalize({
    id: randomUUID(),
    name: input.name?.trim() || (typeof manifest.name === "string" && manifest.name.trim()) || name,
    description: typeof manifest.description === "string" ? manifest.description : undefined,
    url,
    path: target,
    command,
    args,
    env: manifest.env,
    passCredentials: input.passCredentials === true || manifest.passCredentials === true,
    discovered,
    createdAt: Date.now(),
  });
  agents.push(agent);
  await persist();
  return {
    agent,
    discovered,
    hint: command ? hint : "未发现启动方式（agent.json / package.json / 常见入口都不存在），请补一条启动命令",
  };
}

/** 补全 / 修正启动命令（接入时未发现运行方式的 Agent） */
export async function updateExternalAgent(id: string, input: {
  name?: string; command?: string; args?: unknown; passCredentials?: unknown;
}): Promise<ExternalAgent> {
  const a = agents.find((x) => x.id === id);
  if (!a) throw new Error("外部 Agent 不存在");
  if (input.name?.trim()) a.name = input.name.trim();
  if (input.command !== undefined) {
    if (!input.command.trim()) throw new Error("启动命令不能为空");
    a.command = input.command.trim();
    a.discovered = false;
  }
  if (Array.isArray(input.args)) a.args = (input.args as unknown[]).map(String);
  if (input.passCredentials !== undefined) a.passCredentials = input.passCredentials === true;
  await persist();
  return a;
}

export async function deleteExternalAgent(id: string): Promise<void> {
  const a = agents.find((x) => x.id === id);
  if (!a) throw new Error("外部 Agent 不存在");
  await fsp.rm(a.path, { recursive: true, force: true }).catch(() => {});
  agents = agents.filter((x) => x.id !== id);
  await persist();
}

// ---------------------------------------------------------------------------
// 运行：每条消息启动一次子进程，stdout → token 事件流
// ---------------------------------------------------------------------------
export async function* runExternalAgent(agent: ExternalAgent, message: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  if (!agent.command) {
    yield { type: "error", message: "该外部 Agent 还没有配置启动命令，请在「新建对话 → 外部 Agent」里补全" };
    return;
  }

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(agent.env ?? {}), EXTERNAL_AGENT: "1" };
  if (agent.passCredentials) {
    Object.assign(childEnv, {
      AGENT_API_KEY: config.apiKey,
      AGENT_BASE_URL: config.baseURL,
      AGENT_MODEL: config.model,
      OPENAI_API_KEY: config.apiKey,
      OPENAI_BASE_URL: config.baseURL,
      OPENAI_MODEL: config.model,
    });
  }

  const hasPlaceholder = agent.args.some((a) => a.includes("{{prompt}}"));
  const argv = agent.args.map((a) => a.replaceAll("{{prompt}}", message));

  yield { type: "node", name: "external" };

  // Windows 上 npm/npx 是 .cmd，必须走 shell 才能启动；此时消息里的换行会被 cmd 吃掉，压成空格
  const useShell = process.platform === "win32" && /^(npm|npx|pnpm|pnpx|yarn)$/i.test(agent.command);
  const spawnArgs = useShell
    ? [argv.map((a) => `"${a.replace(/\r?\n/g, " ").replace(/"/g, "")}"`).join(" ")]
    : argv;

  const child = spawn(agent.command, spawnArgs, {
    cwd: agent.path,
    env: childEnv,
    shell: useShell,
    windowsHide: true,
    stdio: hasPlaceholder ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });

  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  const onAbort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", onAbort, { once: true });

  if (!hasPlaceholder && child.stdin) {
    child.stdin.write(`${JSON.stringify({ message })}\n`);
    child.stdin.end();
  }

  let stderrTail = "";
  if (child.stderr) {
    child.stderr.on("data", (c: Buffer) => {
      stderrTail = (stderrTail + c.toString("utf8")).slice(-2000);
    });
  }

  const stdout = child.stdout;
  if (stdout) {
    for await (const chunk of stdout) {
      if (signal.aborted) break;
      const text = chunk.toString("utf8");
      if (text) yield { type: "token", text };
    }
  }

  const code: number = await new Promise((resolveExit) => {
    child.on("close", (c) => resolveExit(c ?? -1));
    child.on("error", (e) => {
      stderrTail += `\n${e.message}`;
      resolveExit(-1);
    });
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);

  if (signal.aborted) return;
  if (code !== 0) {
    const tail = stderrTail.trim().split("\n").slice(-6).join("\n");
    yield {
      type: "error",
      message: `外部 Agent 退出码 ${code}${agent.command ? `（${agent.command}）` : ""}\n${tail || "无 stderr 输出"}`,
    };
  }
}
