/**
 * ============================================================
 * config-store.ts — .web-config.json 的共享读写（读-合并-写）
 * ============================================================
 * providers（settings.ts）、projects（projects.ts）、externalAgents
 * （external.ts）共存于同一个文件。之前各方各自整文件覆写，后写的一方
 * 会把先写一方的字段抹掉（例如保存供应商会丢掉项目列表）。
 * 这里统一为：读整个 JSON → 只改自己的键 → 写回，并用进程内互斥队列
 * 串行化写入，避免并发请求交错造成丢字段。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".web-config.json");

export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// 简单互斥：把所有写操作串成一条 promise 链
let writeQueue: Promise<void> = Promise.resolve();

/** 只合并写入 patch 中给出的键，文件里其他键原样保留 */
export async function mergeConfig(patch: Record<string, unknown>): Promise<void> {
  const run = writeQueue.then(runMerge);
  writeQueue = run.catch(() => {}); // 链上不允许出现未处理的 rejection
  await run;

  async function runMerge() {
    const config = await readConfig();
    Object.assign(config, patch);
    await writeFile(SETTINGS_FILE, JSON.stringify(config, null, 2), "utf8");
  }
}
