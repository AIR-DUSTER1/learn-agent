/**
 * tools-dev.ts — 编程/开发类工具集（通用 Agent 用）
 *
 * 给 Agent 配上「正常写代码需要的工具」：
 *   terminal      在项目根目录执行 shell 命令（构建/测试/git/装依赖）—— 高风险，需人工审批
 *   read_file     读项目内文件（授权路径内），文本，超长截断
 *   write_file    创建/覆盖项目内文件 —— 高风险（改磁盘），需人工审批
 *   list_dir      列目录（复用 files.ts 的授权与跳过规则）
 *   grep_search   在项目里按正则搜文本（跳过 node_modules/.git 等，限量返回）
 *
 * 安全设计：
 *   - 读写/列目录/搜索全部走 files.ts 的授权前缀校验（只能碰已授权根）；
 *   - terminal / write_file 在 approvalToolsNode 里注册为「需审批」工具，
 *     模型调用后会先 interrupt 等用户点头，批准才真正执行；
 *   - 终端在 PROJECT_ROOT 下执行，输出限量截断，120s 超时强杀。
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { promises as fsp } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, isAbsolute, dirname } from "node:path";
import { PROJECT_ROOT, assertAuthorized, SKIPPED_DIRS } from "./server/files.js";

const TERM_TIMEOUT_MS = 120_000;
const TERM_OUT_LIMIT = 8_000;      // 终端输出截断（字符）
const READ_LIMIT = 16_000;         // read_file 截断（字符）
const WRITE_LIMIT = 200_000;       // write_file 上限（字符）
const GREP_MAX_MATCHES = 50;       // grep 最多返回条数
const GREP_MAX_FILES = 2000;       // grep 最多扫描文件数
const GREP_FILE_LIMIT = 1_000_000; // grep 单文件大小上限（字节）

/** 相对路径 → 项目根下的绝对路径（已是绝对路径则原样） */
function toAbs(path: string): string {
  const p = path.trim();
  return isAbsolute(p) ? resolve(p) : resolve(PROJECT_ROOT, p);
}

// ---------------------------------------------------------------------------
// 1. 终端：执行 shell 命令（高风险 → 需审批）
// ---------------------------------------------------------------------------
export const terminal = tool(
  async ({ command }) => {
    return new Promise<string>((resolveDone) => {
      const child = spawn(command, {
        cwd: PROJECT_ROOT,
        shell: true,
        windowsHide: true,
        env: process.env,
      });
      let out = "";
      let err = "";
      let truncated = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), TERM_TIMEOUT_MS);
      child.stdout?.on("data", (c: Buffer) => {
        if (out.length < TERM_OUT_LIMIT) out += c.toString("utf8");
        else truncated = true;
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (err.length < TERM_OUT_LIMIT) err += c.toString("utf8");
        else truncated = true;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolveDone(`命令启动失败：${e.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const parts = [
          out.trim() ? `-- stdout --\n${out.slice(0, TERM_OUT_LIMIT)}` : "",
          err.trim() ? `-- stderr --\n${err.slice(0, TERM_OUT_LIMIT)}` : "",
        ].filter(Boolean);
        resolveDone(
          `退出码：${code ?? "未知"}${code === null ? "（超时被终止）" : ""}\n` +
          (parts.join("\n") || "（无输出）") +
          (truncated ? "\n…（输出过长已截断）" : "")
        );
      });
    });
  },
  {
    name: "terminal",
    description:
      "在项目根目录执行一条 shell 命令并返回输出（高风险操作，执行前需要用户批准）。" +
      "适合运行构建、测试、git 操作、安装依赖、查看目录内容等。",
    schema: z.object({
      command: z.string().describe("要执行的命令，例如 npm test、git status、dir"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 2. 读文件（授权路径内）
// ---------------------------------------------------------------------------
export const readFileTool = tool(
  async ({ path }) => {
    const abs = toAbs(path);
    assertAuthorized(abs);
    const st = await fsp.stat(abs).catch(() => { throw new Error("文件不存在"); });
    if (st.isDirectory()) throw new Error("该路径是文件夹，请用 list_dir 列出内容");
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return "（二进制文件，不支持以文本读取）";
    const text = buf.toString("utf8");
    return text.length > READ_LIMIT
      ? text.slice(0, READ_LIMIT) + `\n…（已截断，原文件 ${text.length} 字符）`
      : text;
  },
  {
    name: "read_file",
    description:
      "读取项目内的文本文件内容（相对路径基于项目根，超长截断）。例：src/index.ts 或绝对路径。",
    schema: z.object({
      path: z.string().describe("文件路径（相对项目根或绝对路径）"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 3. 写文件（高风险 → 需审批）
// ---------------------------------------------------------------------------
export const writeFileTool = tool(
  async ({ path, content }) => {
    const abs = toAbs(path);
    assertAuthorized(abs);
    if (content.length > WRITE_LIMIT) throw new Error(`内容过长（${content.length} 字符，上限 ${WRITE_LIMIT}）`);
    await fsp.mkdir(dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, "utf8");
    return `已写入 ${abs}（${content.length} 字符）`;
  },
  {
    name: "write_file",
    description:
      "创建或覆盖项目内的文本文件（相对路径基于项目根；高风险操作，执行前需要用户批准）。" +
      "会覆盖同名文件的全部内容。",
    schema: z.object({
      path: z.string().describe("目标文件路径（相对项目根或绝对路径）"),
      content: z.string().describe("要写入的完整文件内容"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 4. 列目录（复用 files.ts 的授权与跳过规则）
// ---------------------------------------------------------------------------
export const listDirTool = tool(
  async ({ path }) => {
    const abs = toAbs(path || ".");
    assertAuthorized(abs);
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const names: string[] = [];
    for (const d of dirents) {
      if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
      names.push(d.isDirectory() ? `${d.name}/` : d.name);
      if (names.length >= 300) { names.push("…（仅显示前 300 项）"); break; }
    }
    return `${abs}\n${names.join("\n")}`;
  },
  {
    name: "list_dir",
    description: "列出项目内某个目录的内容（相对路径基于项目根，缺省为项目根）。",
    schema: z.object({
      path: z.string().optional().describe("目录路径，缺省为项目根"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 5. 文本搜索（正则，跳过 node_modules/.git 等，限量返回）
// ---------------------------------------------------------------------------
export const grepSearch = tool(
  async ({ pattern, path }) => {
    const base = toAbs(path || ".");
    assertAuthorized(base);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (e) {
      return `正则表达式无效：${e instanceof Error ? e.message : String(e)}`;
    }

    const matches: string[] = [];
    let scanned = 0;

    async function walk(dir: string): Promise<void> {
      if (matches.length >= GREP_MAX_MATCHES || scanned >= GREP_MAX_FILES) return;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const d of dirents) {
        if (matches.length >= GREP_MAX_MATCHES || scanned >= GREP_MAX_FILES) return;
        const full = resolve(dir, d.name);
        if (d.isDirectory()) {
          if (SKIPPED_DIRS.has(d.name)) continue;
          await walk(full);
          continue;
        }
        if (!d.isFile()) continue;
        scanned++;
        const st = await fsp.stat(full).catch(() => null);
        if (!st || st.size > GREP_FILE_LIMIT) continue;
        const buf = await fsp.readFile(full).catch(() => null);
        if (!buf || buf.includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const rel = full.startsWith(PROJECT_ROOT) ? full.slice(PROJECT_ROOT.length + 1) : full;
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= GREP_MAX_MATCHES) return;
          }
        }
      }
    }

    await walk(base);
    if (!matches.length) return `没有匹配「${pattern}」的结果（扫描了 ${scanned} 个文件）。`;
    return `共 ${matches.length} 条匹配（扫描 ${scanned} 个文件）：\n${matches.join("\n")}`;
  },
  {
    name: "grep_search",
    description:
      "在项目内按正则表达式搜索文本（不区分大小写，跳过 node_modules/.git/dist 等，最多返回 50 条）。" +
      "例：pattern=\"createChatModel\", path=\"src\"",
    schema: z.object({
      pattern: z.string().describe("正则表达式"),
      path: z.string().optional().describe("搜索起点目录（相对项目根，缺省为项目根）"),
    }),
  }
);

/** 开发工具集（general agent 绑定；terminal / write_file 需审批） */
export const devTools = [terminal, readFileTool, writeFileTool, listDirTool, grepSearch];
