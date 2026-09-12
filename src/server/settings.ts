/**
 * ============================================================
 * settings.ts — Web 设置页后端：多供应商（网关 / Key / 模型）管理
 * ============================================================
 * 数据模型：一个「供应商档案」= { name, baseURL, apiKey, model }，
 * 可添加任意多个、随时切换；「启用的供应商」的值会被应用到 config
 * （src/config.ts），建图时（llm.ts）读到的就是它。
 *
 * 持久化（.web-config.json，gitignore）：
 *   { "providers": [...], "activeId": "..." }
 * 分层：.env < .web-config.json < 运行中内存。
 *
 * 兼容旧格式：老版本文件是单供应商的平铺结构 { baseURL, apiKey, model }，
 * 加载时自动迁移成一个名为「默认供应商」的档案。
 * 首次启动且无文件时：从 .env 播种一个内存供应商（用户改动后才落盘）。
 *
 * 安全：API Key 永远不回传明文 —— 列表接口只返回掩码（maskKey），
 * 前端编辑时留空 Key 表示「保持不变」。
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { SETTINGS_FILE, mergeConfig } from "./config-store.js";

interface Provider {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  /** 模型能力：text 纯文本（默认）/ vision 多模态（可接收图片输入） */
  modality?: "text" | "vision";
  /** 手动填写的上下文窗口（tokens）；优先于网关 /models 自动获取的 context_length */
  manualContextWindow?: number;
}

let providers: Provider[] = [];
let activeId: string | null = null;

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------
function validBaseURL(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/.+/.test(u)) throw new Error("BASE_URL 必须是 http(s) 开头的完整地址，例如 https://api.example.com/v1");
  return u;
}

function applyActiveToConfig(): void {
  const p = activeProvider();
  if (!p) return;
  config.baseURL = p.baseURL;
  config.apiKey = p.apiKey;
  if (p.model) config.model = p.model;
}

function activeProvider(): Provider | undefined {
  return providers.find((p) => p.id === activeId);
}

async function persist(): Promise<void> {
  // merge 写入：只覆盖 providers/activeId，不碰同文件的 projects / externalAgents 等键
  await mergeConfig({ providers, activeId });
}

// ---------------------------------------------------------------------------
// 启动加载（含旧格式迁移 / .env 播种）
// ---------------------------------------------------------------------------
export async function loadSettings(): Promise<void> {
  let saved: { providers?: unknown; activeId?: unknown; baseURL?: unknown; apiKey?: unknown; model?: unknown } | null = null;
  try {
    saved = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
  } catch {
    saved = null; // 文件不存在 = 没有 Web 端配置
  }

  if (saved && Array.isArray(saved.providers) && saved.providers.length) {
    // ── 新格式：供应商数组 ──
    providers = (saved.providers as Array<Partial<Provider>>)
      .filter((p) => p && typeof p.baseURL === "string" && /^https?:\/\//.test(p.baseURL))
      .map((p) => ({
        id: typeof p.id === "string" && p.id ? p.id : randomUUID(),
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "未命名供应商",
        baseURL: p.baseURL!.trim().replace(/\/+$/, ""),
        apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
        model: typeof p.model === "string" ? p.model.trim() : "",
      }));
    activeId =
      typeof saved.activeId === "string" && providers.some((p) => p.id === saved!.activeId)
        ? (saved.activeId as string)
        : providers[0].id;
    applyActiveToConfig(); // ★ 启动时把启用中的供应商真正套到 config 上
    return;
  }

  if (saved && typeof saved.baseURL === "string") {
    // ── 旧版单供应商平铺格式 → 迁移成一个档案 ──
    providers = [{
      id: randomUUID(),
      name: "默认供应商",
      baseURL: String(saved.baseURL).trim().replace(/\/+$/, ""),
      apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "",
      model: typeof saved.model === "string" ? saved.model.trim() : "",
    }];
    activeId = providers[0].id;
    applyActiveToConfig();
    await persist().catch(() => {});
    return;
  }

  // ── 无文件：从 .env 播种一个内存供应商（任何修改后才会写入文件）──
  providers = [{
    id: "default",
    name: "默认供应商（.env）",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
  }];
  activeId = providers[0].id;
}

// ---------------------------------------------------------------------------
// 查询（对外只给掩码）
// ---------------------------------------------------------------------------
export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  hasKey: boolean;
  keyMasked: string;
  active: boolean;
  modality: "text" | "vision";
  manualContextWindow: number | null;
}

export function listProviders(): PublicProvider[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseURL: p.baseURL,
    model: p.model,
    hasKey: Boolean(p.apiKey),
    keyMasked: maskKey(p.apiKey),
    active: p.id === activeId,
    modality: p.modality ?? "text",
    manualContextWindow: p.manualContextWindow ?? null,
  }));
}

export function getActiveId(): string | null {
  return activeId;
}

// ---------------------------------------------------------------------------
// 增 / 改 / 删 / 切换 —— 返回 activeChanged 提示调用方是否需要 bump 配置版本
// ---------------------------------------------------------------------------

/** 供应商设置的公共字段解析（新增 / 更新共用） */
function parseProviderFields(input: {
  modality?: unknown; contextWindow?: unknown;
}): { modality?: "text" | "vision"; manualContextWindow?: number } {
  const out: { modality?: "text" | "vision"; manualContextWindow?: number } = {};
  if (input.modality === "vision" || input.modality === "text") out.modality = input.modality;
  if (input.contextWindow !== undefined && input.contextWindow !== null && input.contextWindow !== "") {
    const n = Number(input.contextWindow);
    if (!Number.isFinite(n) || n < 1024) throw new Error("上下文窗口需为不小于 1024 的数字（tokens）");
    out.manualContextWindow = Math.round(n);
  }
  return out;
}

/** 添加供应商；若是第一个供应商则自动启用 */
export async function addProvider(input: {
  name?: string; baseURL?: string; apiKey?: string; model?: string;
  modality?: unknown; contextWindow?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const name = input.name?.trim();
  if (!name) throw new Error("供应商名称不能为空");
  if (!input.baseURL) throw new Error("BASE_URL 不能为空");
  if (!input.model?.trim()) throw new Error("模型名不能为空（可先点「获取列表」从网关选择）");
  const extra = parseProviderFields(input);

  const provider: Provider = {
    id: randomUUID(),
    name,
    baseURL: validBaseURL(input.baseURL),
    apiKey: (input.apiKey ?? "").trim(),
    model: input.model.trim(),
    modality: extra.modality ?? "text",
    manualContextWindow: extra.manualContextWindow,
  };
  providers.push(provider);

  const activeChanged = providers.length === 1;
  if (activeChanged) {
    activeId = provider.id;
    applyActiveToConfig();
  }
  await persist();
  return { provider: toPublic(provider), activeChanged };
}

/** 更新供应商；apiKey 缺省 = 保持不变，空串 = 清除。改的是启用中的 → 需要重建会话图 */
export async function updateProvider(id: string, input: {
  name?: string; baseURL?: string; apiKey?: string; model?: string;
  modality?: unknown; contextWindow?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("供应商名称不能为空");
    p.name = input.name.trim();
  }
  if (input.baseURL !== undefined) p.baseURL = validBaseURL(input.baseURL);
  if (input.model !== undefined) {
    if (!input.model.trim()) throw new Error("模型名不能为空");
    p.model = input.model.trim();
  }
  if (typeof input.apiKey === "string") p.apiKey = input.apiKey.trim();
  // 能力/上下文：勾选状态总是提交；上下文空串 = 清除手动值
  if (input.modality !== undefined) {
    if (input.modality !== "vision" && input.modality !== "text") throw new Error("modality 只支持 text / vision");
    p.modality = input.modality;
  }
  if (input.contextWindow !== undefined) {
    if (input.contextWindow === null || input.contextWindow === "") {
      p.manualContextWindow = undefined;
    } else {
      const n = Number(input.contextWindow);
      if (!Number.isFinite(n) || n < 1024) throw new Error("上下文窗口需为不小于 1024 的数字（tokens）");
      p.manualContextWindow = Math.round(n);
    }
  }

  const activeChanged = p.id === activeId;
  if (activeChanged) applyActiveToConfig();
  await persist();
  return { provider: toPublic(p), activeChanged };
}

/** 删除供应商（至少保留一个）；删的是启用中的 → 自动切到第一个 */
export async function deleteProvider(id: string): Promise<{ activeChanged: boolean }> {
  if (providers.length <= 1) throw new Error("至少保留一个供应商");
  const idx = providers.findIndex((x) => x.id === id);
  if (idx === -1) throw new Error("供应商不存在");
  const wasActive = providers[idx].id === activeId;
  providers.splice(idx, 1);
  let activeChanged = false;
  if (wasActive) {
    activeId = providers[0].id;
    applyActiveToConfig();
    activeChanged = true;
  }
  await persist();
  return { activeChanged };
}

/** 切换启用的供应商（未设置模型的供应商不允许启用） */
export async function activateProvider(id: string): Promise<{ activeChanged: boolean; name: string; model: string }> {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (!p.model) throw new Error(`「${p.name}」还没有设置模型，先编辑补上再启用`);
  const activeChanged = p.id !== activeId;
  activeId = p.id;
  applyActiveToConfig();
  await persist();
  return { activeChanged, name: p.name, model: p.model };
}

function toPublic(p: Provider): PublicProvider {
  return {
    id: p.id, name: p.name, baseURL: p.baseURL, model: p.model,
    hasKey: Boolean(p.apiKey), keyMasked: maskKey(p.apiKey), active: p.id === activeId,
    modality: p.modality ?? "text", manualContextWindow: p.manualContextWindow ?? null,
  };
}

/** 启用中供应商的模型能力（vision = 可接收图片输入） */
export function getActiveModality(): "text" | "vision" {
  return activeProvider()?.modality ?? "text";
}

// ---------------------------------------------------------------------------
// 模型元信息缓存：context_length（上下文窗口）来自网关 /models 返回的字段
// （与 scripts/list-models.ts 看到的 GatewayModel.context_length 同源），
// 用于前端的「上下文容量条」。缓存按 供应商id → 模型id → 窗口长度 组织，仅存内存。
// ---------------------------------------------------------------------------
const modelContextCache = new Map<string, Map<string, number | undefined>>();

/** 启用中 供应商+模型 的上下文窗口长度（未知返回 undefined）；
 *  手动填写的值优先于网关 /models 自动获取的 context_length */
export function getContextWindowForActive(): number | undefined {
  const p = activeProvider();
  if (!p) return undefined;
  if (p.manualContextWindow) return p.manualContextWindow;
  return modelContextCache.get(p.id)?.get(p.model);
}

/**
 * 后台刷新启用中供应商的模型列表（拉不到就静默放弃），
 * 目的只有一个：把 context_length 灌进缓存，让容量条有分母。
 * 在服务启动 / 切换供应商时 fire-and-forget 调用。
 */
export async function refreshModelInfo(): Promise<void> {
  const p = activeProvider();
  if (!p || !p.apiKey) return; // 无 Key（模拟模式）时网关必然 401，不折腾
  try {
    const details = await fetchModelDetails({ providerId: p.id });
    modelContextCache.set(p.id, details);
  } catch {
    /* 网关不可达 / Key 无效 → 容量条退化为「未知窗口」形态 */
  }
}

/** API Key 掩码：只露出首尾，避免明文回传到浏览器 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/**
 * 用给定（或指定供应商已保存）的网关配置拉取模型列表 —— 同时充当「测试连接」。
 * 优先级：显式 baseURL/apiKey > providerId 对应的已存档案 > 当前启用的供应商。
 * 返回 {模型id → 上下文窗口长度} 映射（网关不报 context_length 时值为 undefined）。
 */
export async function fetchModelDetails(opts: { baseURL?: string; apiKey?: string; providerId?: string }): Promise<Map<string, number | undefined>> {
  let url = opts.baseURL?.trim();
  let key = opts.apiKey;
  if ((!url || key === undefined) && opts.providerId) {
    const p = providers.find((x) => x.id === opts.providerId);
    if (!p) throw new Error("供应商不存在");
    url = url || p.baseURL;
    key = key !== undefined && key !== "" ? key : p.apiKey;
  }
  if (!url) url = config.baseURL;

  const u = validBaseURL(url);
  const res = await fetch(`${u}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`网关返回 HTTP ${res.status}（检查地址是否以 /v1 结尾、Key 是否有效）`);
  }
  const body = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
  const details = new Map<string, number | undefined>();
  for (const m of body.data ?? []) {
    if (m.id) details.set(m.id, typeof m.context_length === "number" ? m.context_length : undefined);
  }
  if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
  return details;
}

/** 拉取模型列表的 id 视图（设置页 datalist 用），同时把详情写入缓存 */
export async function fetchGatewayModels(opts: { baseURL?: string; apiKey?: string; providerId?: string }): Promise<string[]> {
  const details = await fetchModelDetails(opts);
  const providerId = opts.providerId ?? activeProvider()?.id;
  if (providerId) {
    const merged = modelContextCache.get(providerId) ?? new Map<string, number | undefined>();
    for (const [k, v] of details) merged.set(k, v);
    modelContextCache.set(providerId, merged);
  }
  return [...details.keys()].sort();
}
