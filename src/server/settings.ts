/**
 * ============================================================
 * settings.ts — Web 设置页后端：多供应商 × 多模型管理
 * ============================================================
 * 数据模型（v2，落盘在 .web-config.json，已 gitignore）：
 *
 *   providers: [
 *     {
 *       id, name, baseURL, apiKey, protocol,          // 「一个供应商」= 一套网关凭据
 *       models: [                                     // ★ 一个供应商可挂多个模型
 *         {
 *           id, name, label?,                         // name = 真正发给网关的 model 字段
 *           modality: "text" | "vision",              // 该模型能否吃图片
 *           manualContextWindow?,                     // 手动指定上下文窗口（优先于网关）
 *           reasoning: { dialect, level, custom? },   // ★ 该模型的思考等级（按供应商方言）
 *         }
 *       ],
 *       activeModelId,                                // 该供应商当前选中的模型
 *     }
 *   ],
 *   activeId: 启用的供应商 id
 *
 * 为什么把「模型」从供应商里拆成数组？
 *   同一个网关（一套 baseURL + Key）通常能提供好几个模型
 *   （例如 DeepSeek 官方同时有 deepseek-flash 与 deepseek-v4-pro），
 *   旧版每个供应商只能存一个模型名，切换模型就得建一个「供应商」，
 *   于是顶栏下拉里出现一堆同网关的重复条目，而真正想选的第二个模型却没有入口。
 *
 * 分层：.env < .web-config.json < 运行中内存。
 * 兼容旧格式：
 *   - v1 供应商（单个 model 字段）→ 自动迁移成 models 数组里的一个条目；
 *   - 更老的平铺格式 { baseURL, apiKey, model } → 迁移成一个供应商档案。
 * 首次启动且无文件时：从 .env 播种一个内存供应商（用户改动后才落盘）。
 *
 * 安全：API Key 永远不回传明文 —— 列表接口只返回掩码（maskKey），
 * 前端编辑时留空 Key 表示「保持不变」。
 */
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config, isProtocol, type Protocol } from "../config.js";
import {
  DEFAULT_REASONING,
  DIALECTS,
  getDialect,
  isDialectId,
  resolveReasoning,
  type ReasoningDialectId,
  type ReasoningSetting,
} from "../reasoning.js";
import { SETTINGS_FILE, mergeConfig } from "./config-store.js";

// ---------------------------------------------------------------------------
// 内部数据结构
// ---------------------------------------------------------------------------
interface ModelEntry {
  id: string;
  /** 真正发给网关的模型名（model 字段） */
  name: string;
  /** 显示名（留空 = 用 name） */
  label?: string;
  /** 模型能力：text 纯文本（默认）/ vision 多模态（可接收图片输入） */
  modality: "text" | "vision";
  /** 手动填写的上下文窗口（tokens）；优先于网关 /models 自动获取的 context_length */
  manualContextWindow?: number;
  /** 该模型的思考等级（方言 + 档位） */
  reasoning: ReasoningSetting;
}

interface Provider {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  /**
   * 请求协议：openai（Chat Completions，默认）/ openai-responses（Responses API）/
   * anthropic（Messages 原生）/ gemini（generateContent 原生）。
   * 多协议中转站按此决定请求打到 {baseURL} 的哪个路径。
   */
  protocol: Protocol;
  models: ModelEntry[];
  /** 该供应商当前启用的模型 id */
  activeModelId: string;
}

/** 网关 /models 里能拿到的模型元信息（拿不到就是 undefined） */
export interface GatewayModelInfo {
  contextWindow?: number;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
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

function activeProvider(): Provider | undefined {
  return providers.find((p) => p.id === activeId);
}

function activeModelOf(p: Provider | undefined): ModelEntry | undefined {
  if (!p) return undefined;
  return p.models.find((m) => m.id === p.activeModelId) ?? p.models[0];
}

/** 把「启用的供应商 + 它的启用模型」真正套到运行时 config 上（llm.ts 建模型时读它） */
function applyActiveToConfig(): void {
  const p = activeProvider();
  if (!p) return;
  config.baseURL = p.baseURL;
  config.apiKey = p.apiKey;
  config.protocol = p.protocol ?? "openai";
  const m = activeModelOf(p);
  if (m) {
    config.model = m.name;
    config.reasoning = { ...DEFAULT_REASONING, ...m.reasoning };
  } else {
    config.reasoning = { ...DEFAULT_REASONING };
  }
}

async function persist(): Promise<void> {
  // merge 写入：只覆盖 providers/activeId，不碰同文件的 projects / externalAgents 等键
  await mergeConfig({ version: 2, providers, activeId });
}

/** 解析模型字段（新增 / 更新共用）——只返回「调用方真的传了」的键 */
function parseModelFields(input: {
  modality?: unknown; contextWindow?: unknown; reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
}): Partial<Pick<ModelEntry, "modality" | "manualContextWindow" | "reasoning">> {
  const out: Partial<Pick<ModelEntry, "modality" | "manualContextWindow" | "reasoning">> = {};
  if (input.modality === "vision" || input.modality === "text") out.modality = input.modality;

  if (input.contextWindow !== undefined) {
    if (input.contextWindow === null || input.contextWindow === "") {
      out.manualContextWindow = undefined; // 空 = 清除手动值，回到「自动从网关获取」
    } else {
      const n = Number(input.contextWindow);
      if (!Number.isFinite(n) || n < 1024) throw new Error("上下文窗口需为不小于 1024 的数字（tokens）");
      out.manualContextWindow = Math.round(n);
    }
  }

  // 思考等级：既接受 { reasoning: { dialect, level, custom } } 整体，也接受扁平字段。
  // ★ 只写入调用方给出的键 —— 顶栏快捷切换只传 level，不能把用户选好的方言冲回 auto。
  const raw = (input.reasoning && typeof input.reasoning === "object" ? input.reasoning : {}) as Record<string, unknown>;
  const dialectRaw = raw.dialect ?? input.dialect;
  const levelRaw = raw.level ?? input.level;
  const customRaw = raw.custom ?? input.custom;
  if (dialectRaw !== undefined || levelRaw !== undefined || customRaw !== undefined) {
    const reasoning: Partial<ReasoningSetting> = {};
    if (dialectRaw !== undefined) {
      if (!isDialectId(dialectRaw)) throw new Error(`未知的思考等级方言：${String(dialectRaw)}（见设置页下拉里的可选值）`);
      reasoning.dialect = dialectRaw;
    }
    if (levelRaw !== undefined) {
      if (typeof levelRaw !== "string" || !levelRaw.trim()) throw new Error("思考等级档位不能为空");
      reasoning.level = levelRaw.trim();
    }
    if (customRaw !== undefined) {
      const text = String(customRaw ?? "");
      if (text.length > 4000) throw new Error("自定义 JSON 过长（上限 4000 字符）");
      reasoning.custom = text;
    }
    out.reasoning = reasoning as ReasoningSetting;
  }
  return out;
}

/**
 * 校验「方言 + 档位」组合（在合并完最终值之后调用）：
 * 档位必须属于该方言，自定义 JSON 必须能解析 —— 否则用户选了档位却什么也没发生。
 */
function assertReasoningValid(reasoning: ReasoningSetting, ctx: { baseURL: string; model: string; protocol: Protocol }): void {
  const resolved = resolveReasoning(reasoning, ctx);
  if (resolved.error) throw new Error(resolved.error);
  const dialect = getDialect(resolved.dialect);
  const level = reasoning.level ?? "default";
  const known = dialect.levels.some((l) => l.id === level);
  if (!known && level !== "custom") {
    throw new Error(
      `「${dialect.label}」没有「${level}」这个档位（可选：${dialect.levels.map((l) => l.id).join(" / ")}）`
    );
  }
}

/** 把一个「模型输入」解析成 ModelEntry（新增 / 从网关导入都用它） */
function toModelEntry(input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown; reasoning?: unknown;
}): ModelEntry {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("模型名不能为空（可先点「获取列表」从网关选择）");
  const extra = parseModelFields(input);
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : undefined;
  return {
    id: randomUUID(),
    name,
    label,
    modality: extra.modality ?? "text",
    manualContextWindow: extra.manualContextWindow,
    reasoning: extra.reasoning ?? { ...DEFAULT_REASONING },
  };
}

// ---------------------------------------------------------------------------
// 启动加载（含旧格式迁移 / .env 播种）
// ---------------------------------------------------------------------------
/** 把文件里的一条供应商记录（v1 或 v2）规范成 v2 结构 */
function normalizeProvider(raw: Record<string, unknown>): Provider {
  const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "未命名供应商";
  const baseURL = String(raw.baseURL ?? "").trim().replace(/\/+$/, "");
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
  const protocol = isProtocol(raw.protocol) ? raw.protocol : "openai";

  const models: ModelEntry[] = [];
  if (Array.isArray(raw.models)) {
    for (const item of raw.models as Array<Record<string, unknown>>) {
      if (!item || typeof item.name !== "string" || !item.name.trim()) continue;
      const reasoningRaw = (item.reasoning && typeof item.reasoning === "object" ? item.reasoning : {}) as Record<string, unknown>;
      const dialect = isDialectId(reasoningRaw.dialect) ? (reasoningRaw.dialect as ReasoningDialectId | "auto") : "auto";
      models.push({
        id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
        name: item.name.trim(),
        label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined,
        modality: item.modality === "vision" ? "vision" : "text",
        manualContextWindow: typeof item.manualContextWindow === "number" ? item.manualContextWindow : undefined,
        reasoning: {
          dialect,
          level: typeof reasoningRaw.level === "string" && reasoningRaw.level ? reasoningRaw.level : "default",
          custom: typeof reasoningRaw.custom === "string" ? reasoningRaw.custom : undefined,
        },
      });
    }
  }

  // ── v1 迁移：单个 model + modality + manualContextWindow → models 里的一个条目 ──
  if (!models.length && typeof raw.model === "string" && raw.model.trim()) {
    models.push({
      id: randomUUID(),
      name: raw.model.trim(),
      modality: raw.modality === "vision" ? "vision" : "text",
      manualContextWindow: typeof raw.manualContextWindow === "number" ? raw.manualContextWindow : undefined,
      reasoning: { ...DEFAULT_REASONING },
    });
  }

  const activeModelId =
    typeof raw.activeModelId === "string" && models.some((m) => m.id === raw.activeModelId)
      ? (raw.activeModelId as string)
      : models[0]?.id ?? "";

  return { id, name, baseURL, apiKey, protocol, models, activeModelId };
}

export async function loadSettings(): Promise<void> {
  let saved: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    saved = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    saved = null; // 文件不存在 = 没有 Web 端配置
  }

  if (saved && Array.isArray(saved.providers) && saved.providers.length) {
    // ── 供应商数组（v1 单模型 / v2 多模型都会在这里被规范成 v2）──
    providers = (saved.providers as Array<Record<string, unknown>>)
      .filter((p) => p && typeof p.baseURL === "string" && /^https?:\/\//.test(p.baseURL))
      .map(normalizeProvider);
    if (!providers.length) return seedFromEnv();
    const savedActive = typeof saved.activeId === "string" ? saved.activeId : "";
    activeId = providers.some((p) => p.id === savedActive) ? savedActive : providers[0].id;
    applyActiveToConfig(); // ★ 启动时把启用中的供应商 + 模型真正套到 config 上
    return;
  }

  if (saved && typeof saved.baseURL === "string") {
    // ── 更老的单供应商平铺格式 → 迁移成一个档案 ──
    providers = [normalizeProvider({ ...saved, id: randomUUID(), name: "默认供应商" })];
    activeId = providers[0].id;
    applyActiveToConfig();
    await persist().catch(() => {});
    return;
  }

  seedFromEnv();
}

/** 无文件：从 .env 播种一个内存供应商（任何修改后才会写入文件） */
function seedFromEnv(): void {
  const model: ModelEntry = {
    id: randomUUID(),
    name: config.model,
    modality: "text",
    reasoning: { ...DEFAULT_REASONING },
  };
  providers = [{
    id: "default",
    name: "默认供应商（.env）",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    protocol: config.protocol,
    models: [model],
    activeModelId: model.id,
  }];
  activeId = providers[0].id;
}

// ---------------------------------------------------------------------------
// 查询（对外只给掩码 + 解析好的展示信息）
// ---------------------------------------------------------------------------
export interface PublicModel {
  id: string;
  /** 发给网关的模型名 */
  name: string;
  /** 显示名（默认等于 name） */
  displayName: string;
  modality: "text" | "vision";
  manualContextWindow: number | null;
  /** 该模型实际生效的上下文窗口（手动值优先，其次网关） */
  contextWindow: number | null;
  /** 思考等级设置（auto = 自动识别方言） */
  reasoning: ReasoningSetting;
  /** 解析后的方言 id 与档位（auto 会被解析成具体方言） */
  reasoningDialect: ReasoningDialectId;
  reasoningLevel: string;
  reasoningLabel: string;
  reasoningError: string | null;
  /** 该供应商下当前启用的模型 */
  active: boolean;
  gateway: GatewayModelInfo | null;
}

export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  hasKey: boolean;
  keyMasked: string;
  active: boolean;
  protocol: Protocol;
  /** 当前启用模型的名字（无模型时为空串，兼容旧前端字段） */
  model: string;
  activeModelId: string | null;
  models: PublicModel[];
}

export function listProviders(): PublicProvider[] {
  return providers.map(toPublic);
}

export function getActiveId(): string | null {
  return activeId;
}

export function getActiveModelId(): string | null {
  return activeModelOf(activeProvider())?.id ?? null;
}

function toPublicModel(p: Provider, m: ModelEntry): PublicModel {
  const ctx = { baseURL: p.baseURL, model: m.name, protocol: p.protocol };
  const resolved = resolveReasoning(m.reasoning, ctx);
  const gateway = modelInfoCache.get(p.id)?.get(m.name) ?? null;
  return {
    id: m.id,
    name: m.name,
    displayName: m.label || m.name,
    modality: m.modality ?? "text",
    manualContextWindow: m.manualContextWindow ?? null,
    contextWindow: m.manualContextWindow ?? gateway?.contextWindow ?? null,
    reasoning: { ...DEFAULT_REASONING, ...m.reasoning },
    reasoningDialect: resolved.dialect,
    reasoningLevel: resolved.level,
    reasoningLabel: resolved.label,
    reasoningError: resolved.error ?? null,
    active: m.id === p.activeModelId,
    gateway,
  };
}

function toPublic(p: Provider): PublicProvider {
  const activeM = activeModelOf(p);
  return {
    id: p.id,
    name: p.name,
    baseURL: p.baseURL,
    hasKey: Boolean(p.apiKey),
    keyMasked: maskKey(p.apiKey),
    active: p.id === activeId,
    protocol: p.protocol ?? "openai",
    model: activeM?.name ?? "",
    activeModelId: activeM?.id ?? null,
    models: p.models.map((m) => toPublicModel(p, m)),
  };
}

/** 启用中供应商的模型能力（vision = 可接收图片输入） */
export function getActiveModality(): "text" | "vision" {
  return activeModelOf(activeProvider())?.modality ?? "text";
}

/** 启用中「供应商 + 模型」的上下文窗口长度（未知返回 undefined）；
 *  手动填写的值优先于网关 /models 自动获取的 context_length */
export function getContextWindowForActive(): number | undefined {
  const p = activeProvider();
  const m = activeModelOf(p);
  if (!p || !m) return undefined;
  if (m.manualContextWindow) return m.manualContextWindow;
  return modelInfoCache.get(p.id)?.get(m.name)?.contextWindow;
}

/**
 * 当前启用模型的思考等级状态（给前端渲染「等级下拉 + 说明」用）。
 * dialect 是 auto 时会带上解析结果，前端展示「自动识别为 XXX」。
 */
export function getReasoningState() {
  const p = activeProvider();
  const m = activeModelOf(p);
  const setting: ReasoningSetting = { ...DEFAULT_REASONING, ...(m?.reasoning ?? {}) };
  const resolved = resolveReasoning(setting, { baseURL: p?.baseURL, model: m?.name, protocol: p?.protocol });
  const dialect = getDialect(resolved.dialect);
  return {
    dialect: resolved.dialect,
    dialectLabel: dialect.label,
    vendor: dialect.vendor,
    field: dialect.field,
    scheme: dialect.scheme,
    auto: (setting.dialect ?? "auto") === "auto",
    level: resolved.level,
    label: resolved.label,
    error: resolved.error ?? null,
    custom: setting.custom ?? "",
    levels: dialect.levels.map((l) => ({ id: l.id, label: l.label, desc: l.desc })),
  };
}

/** 方言目录（设置页渲染「思考等级划分方式」下拉用） */
export function listDialects() {
  return DIALECTS.map((d) => ({
    id: d.id,
    label: d.label,
    vendor: d.vendor,
    field: d.field,
    scheme: d.scheme,
    protocols: d.protocols ?? null,
    levels: d.levels.map((l) => ({ id: l.id, label: l.label, desc: l.desc })),
  }));
}

// ---------------------------------------------------------------------------
// 供应商：增 / 改 / 删 / 切换
// ---------------------------------------------------------------------------

/** 添加供应商；若是第一个供应商则自动启用 */
export async function addProvider(input: {
  name?: string; baseURL?: string; apiKey?: string; protocol?: unknown;
  /** v2：直接带一组模型 */
  models?: unknown;
  /** v1 兼容：单个模型名 */
  model?: string; modality?: unknown; contextWindow?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const name = input.name?.trim();
  if (!name) throw new Error("供应商名称不能为空");
  if (!input.baseURL) throw new Error("BASE_URL 不能为空");
  if (input.protocol !== undefined && !isProtocol(input.protocol)) {
    throw new Error("协议只支持 openai / openai-responses / anthropic / gemini");
  }

  const models: ModelEntry[] = [];
  if (Array.isArray(input.models)) {
    for (const item of input.models as Array<Record<string, unknown>>) models.push(toModelEntry(item ?? {}));
  }
  if (!models.length && input.model?.trim()) {
    models.push(toModelEntry({ name: input.model, modality: input.modality, contextWindow: input.contextWindow }));
  }
  if (!models.length) throw new Error("至少填一个模型名（可先点「获取列表」从网关选择）");
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.name)) throw new Error(`模型「${m.name}」重复了`);
    seen.add(m.name);
  }

  const provider: Provider = {
    id: randomUUID(),
    name,
    baseURL: validBaseURL(input.baseURL),
    apiKey: (input.apiKey ?? "").trim(),
    protocol: isProtocol(input.protocol) ? input.protocol : "openai",
    models,
    activeModelId: models[0].id,
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

/** 更新供应商本身（名称 / 网关 / Key / 协议）；模型请用 addModel / updateModel */
export async function updateProvider(id: string, input: {
  name?: string; baseURL?: string; apiKey?: string; protocol?: unknown;
}): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("供应商名称不能为空");
    p.name = input.name.trim();
  }
  if (input.baseURL !== undefined) p.baseURL = validBaseURL(input.baseURL);
  if (typeof input.apiKey === "string") p.apiKey = input.apiKey.trim();
  if (input.protocol !== undefined) {
    if (!isProtocol(input.protocol)) throw new Error("协议只支持 openai / openai-responses / anthropic / gemini");
    p.protocol = input.protocol;
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

/**
 * 启用「供应商 + 模型」。
 * 顶栏下拉现在直接列出「每个供应商的每个模型」，所以这里一次到位：
 * 传 modelId 就同时切换该供应商内的启用模型。
 */
export async function activate(id: string, modelId?: string): Promise<{
  activeChanged: boolean; name: string; model: string; reasoningLabel: string;
}> {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在");
  if (!p.models.length) throw new Error(`「${p.name}」还没有添加模型，先编辑补上再启用`);
  if (modelId) {
    const target = p.models.find((m) => m.id === modelId);
    if (!target) throw new Error("模型不存在（可能已被删除）");
    p.activeModelId = target.id;
  }
  const activeChanged = p.id !== activeId || !activeModelOf(p);
  activeId = p.id;
  applyActiveToConfig();
  await persist();
  const state = getReasoningState();
  return { activeChanged, name: p.name, model: config.model, reasoningLabel: state.label };
}

// ---------------------------------------------------------------------------
// 模型：增 / 改 / 删（一个供应商可以挂多个模型）
// ---------------------------------------------------------------------------

/** 给某个供应商添加模型；同名模型已存在时按「更新」处理（返回 created=false） */
export async function addModel(providerId: string, input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown;
  reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
  /** true = 添加后立即设为该供应商的启用模型（默认 true） */
  makeActive?: unknown;
}): Promise<{ provider: PublicProvider; model: PublicModel; created: boolean; activeChanged: boolean }> {
  const p = providers.find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("模型名不能为空（可先点「获取列表」从网关选择）");

  const existing = p.models.find((m) => m.name === name);
  const extra = parseModelFields(input);
  if (existing) {
    if (extra.modality) existing.modality = extra.modality;
    if ("manualContextWindow" in extra) existing.manualContextWindow = extra.manualContextWindow;
    if (extra.reasoning) {
      const merged = { ...DEFAULT_REASONING, ...existing.reasoning, ...extra.reasoning };
      assertReasoningValid(merged, { baseURL: p.baseURL, model: existing.name, protocol: p.protocol });
      existing.reasoning = merged;
    }
    if (typeof input.label === "string" && input.label.trim()) existing.label = input.label.trim();
    if (input.makeActive !== false) p.activeModelId = existing.id;
    const activeChanged = p.id === activeId;
    if (activeChanged) applyActiveToConfig();
    await persist();
    return { provider: toPublic(p), model: toPublicModel(p, existing), created: false, activeChanged };
  }

  const entry = toModelEntry(input);
  entry.name = name;
  assertReasoningValid(entry.reasoning, { baseURL: p.baseURL, model: entry.name, protocol: p.protocol });
  p.models.push(entry);
  if (input.makeActive !== false) p.activeModelId = entry.id;
  const activeChanged = p.id === activeId;
  if (activeChanged) applyActiveToConfig();
  await persist();
  return { provider: toPublic(p), model: toPublicModel(p, entry), created: true, activeChanged };
}

/** 更新某个模型的全部可编辑字段（模型名 / 显示名 / 多模态 / 上下文窗口 / 思考等级） */
export async function updateModel(providerId: string, modelId: string, input: {
  name?: unknown; label?: unknown; modality?: unknown; contextWindow?: unknown;
  reasoning?: unknown; dialect?: unknown; level?: unknown; custom?: unknown;
  makeActive?: unknown;
}): Promise<{ provider: PublicProvider; model: PublicModel; activeChanged: boolean }> {
  const p = providers.find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  const m = p.models.find((x) => x.id === modelId);
  if (!m) throw new Error("模型不存在");

  if (input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("模型名不能为空");
    if (p.models.some((x) => x.id !== m.id && x.name === name)) throw new Error(`该供应商里已经有模型「${name}」了`);
    m.name = name;
  }
  if (input.label !== undefined) {
    const label = typeof input.label === "string" ? input.label.trim() : "";
    m.label = label || undefined;
  }
  const extra = parseModelFields(input);
  if (extra.modality) m.modality = extra.modality;
  if ("manualContextWindow" in extra) m.manualContextWindow = extra.manualContextWindow;
  if (extra.reasoning) {
    const merged = { ...DEFAULT_REASONING, ...m.reasoning, ...extra.reasoning };
    assertReasoningValid(merged, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
    m.reasoning = merged;
  }
  if (input.makeActive === true) p.activeModelId = m.id;

  const activeChanged = p.id === activeId;
  if (activeChanged) applyActiveToConfig();
  await persist();
  return { provider: toPublic(p), model: toPublicModel(p, m), activeChanged };
}

/** 删除模型（每个供应商至少保留一个）；删的是启用中的 → 自动切到第一个 */
export async function deleteModel(providerId: string, modelId: string): Promise<{ provider: PublicProvider; activeChanged: boolean }> {
  const p = providers.find((x) => x.id === providerId);
  if (!p) throw new Error("供应商不存在");
  if (p.models.length <= 1) throw new Error("每个供应商至少保留一个模型");
  const idx = p.models.findIndex((x) => x.id === modelId);
  if (idx === -1) throw new Error("模型不存在");
  const wasActive = p.models[idx].id === p.activeModelId;
  p.models.splice(idx, 1);
  if (wasActive) p.activeModelId = p.models[0].id;
  const activeChanged = p.id === activeId;
  if (activeChanged) applyActiveToConfig();
  await persist();
  return { provider: toPublic(p), activeChanged };
}

/**
 * 只改「思考等级」——顶栏快捷切换与设置页档位下拉都走它。
 * 不传 providerId/modelId 时作用于当前启用的模型。
 */
export async function setReasoning(input: {
  providerId?: unknown; modelId?: unknown;
  dialect?: unknown; level?: unknown; custom?: unknown;
}): Promise<{ providerId: string; modelId: string; provider: PublicProvider; model: PublicModel; reasoningLabel: string; activeChanged: boolean }> {
  const p = (typeof input.providerId === "string" ? providers.find((x) => x.id === input.providerId) : undefined) ?? activeProvider();
  if (!p) throw new Error("供应商不存在");
  const m = (typeof input.modelId === "string" ? p.models.find((x) => x.id === input.modelId) : undefined) ?? activeModelOf(p);
  if (!m) throw new Error("该供应商还没有模型");
  const extra = parseModelFields({ dialect: input.dialect, level: input.level, custom: input.custom });
  const merged = { ...DEFAULT_REASONING, ...m.reasoning, ...(extra.reasoning ?? {}) };
  assertReasoningValid(merged, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
  m.reasoning = merged;

  const activeChanged = p.id === activeId;
  if (activeChanged) applyActiveToConfig();
  await persist();
  const resolved = resolveReasoning(m.reasoning, { baseURL: p.baseURL, model: m.name, protocol: p.protocol });
  return { providerId: p.id, modelId: m.id, provider: toPublic(p), model: toPublicModel(p, m), reasoningLabel: resolved.label, activeChanged };
}

// ---------------------------------------------------------------------------
// 模型元信息缓存：context_length（上下文窗口）来自网关 /models 返回的字段
// （与 scripts/list-models.ts 看到的 GatewayModel.context_length 同源），
// 用于前端的「上下文容量条」与「从网关添加模型时预填能力」。
// 缓存按 供应商id → 模型id → 元信息 组织，仅存内存。
// ---------------------------------------------------------------------------
const modelInfoCache = new Map<string, Map<string, GatewayModelInfo>>();

/** API Key 掩码：只露出首尾，避免明文回传到浏览器 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

/**
 * 后台刷新启用中供应商的模型列表（拉不到就静默放弃），
 * 目的：把 context_length / 能力标记灌进缓存，让容量条与「添加模型」有依据。
 * 在服务启动 / 切换供应商 / 增删模型时 fire-and-forget 调用。
 */
export async function refreshModelInfo(): Promise<void> {
  const p = activeProvider();
  if (!p || !p.apiKey) return; // 无 Key（模拟模式）时网关必然 401，不折腾
  try {
    const details = await fetchModelDetails({ providerId: p.id });
    modelInfoCache.set(p.id, details);
  } catch {
    /* 网关不可达 / Key 无效 → 容量条退化为「未知窗口」形态 */
  }
}

/**
 * 用给定（或指定供应商已保存）的网关配置拉取模型列表 —— 同时充当「测试连接」。
 * 优先级：显式 baseURL/apiKey > providerId 对应的已存档案 > 当前启用的供应商。
 * 按 provider 协议探测模型列表：openai 系、anthropic、gemini 各自的列表端点与鉴权头。
 * 返回 {模型id → 元信息} 映射（网关不报的字段就是 undefined）。
 */
export async function fetchModelDetails(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<Map<string, GatewayModelInfo>> {
  let url = opts.baseURL?.trim();
  let key = opts.apiKey;
  let protocol: Protocol | undefined;
  if ((!url || key === undefined) && opts.providerId) {
    const p = providers.find((x) => x.id === opts.providerId);
    if (!p) throw new Error("供应商不存在");
    url = url || p.baseURL;
    key = key !== undefined && key !== "" ? key : p.apiKey;
    protocol = p.protocol;
  }
  if (!url) url = config.baseURL;
  if (!protocol && opts.protocol !== undefined && isProtocol(opts.protocol)) protocol = opts.protocol;
  const u = validBaseURL(url);

  // ── Anthropic Messages 原生：GET {base}/v1/models，x-api-key 鉴权 ──
  if (protocol === "anthropic") {
    const res = await fetch(`${u}/v1/models?limit=100`, {
      headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}（Anthropic 协议：检查地址是否指向 {网关}/anthropic 一类根路径、Key 是否有效）`);
    const body = await res.json() as { data?: Array<{ id?: string; display_name?: string }> };
    const details = new Map<string, GatewayModelInfo>();
    for (const m of body.data ?? []) {
      if (m.id) details.set(m.id, {});
      else if (m.display_name) details.set(m.display_name, {});
    }
    if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
    return details;
  }

  // ── Gemini 原生：GET {base}/v1beta/models?key=… ──
  if (protocol === "gemini") {
    const res = await fetch(`${u}/v1beta/models?pageSize=100&key=${encodeURIComponent(key ?? "")}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}（Gemini 协议：检查地址是否为 {网关} 根路径、Key 是否有效）`);
    const body = await res.json() as { models?: Array<{ name?: string; inputTokenLimit?: number }> };
    const details = new Map<string, GatewayModelInfo>();
    for (const m of body.models ?? []) {
      if (m.name) details.set(m.name.replace(/^models\//, ""), { contextWindow: m.inputTokenLimit });
    }
    if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
    return details;
  }

  // ── OpenAI Chat Completions / Responses API：GET {base}/models ──
  const res = await fetch(`${u}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`网关返回 HTTP ${res.status}（检查地址是否以 /v1 结尾、Key 是否有效）`);
  }
  const body = (await res.json()) as {
    data?: Array<{
      id?: string; context_length?: number; inputTokenLimit?: number;
      supports_vision?: boolean; supportsVision?: boolean;
      supports_reasoning?: boolean; supportsReasoning?: boolean;
    }>;
  };
  const details = new Map<string, GatewayModelInfo>();
  for (const m of body.data ?? []) {
    if (!m.id) continue;
    details.set(m.id, {
      contextWindow: typeof m.context_length === "number" ? m.context_length : typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
      supportsVision: typeof m.supports_vision === "boolean" ? m.supports_vision : m.supportsVision,
      supportsReasoning: typeof m.supports_reasoning === "boolean" ? m.supports_reasoning : m.supportsReasoning,
    });
  }
  if (!details.size) throw new Error("网关连接成功，但没有返回任何模型");
  return details;
}

/**
 * 拉取模型列表（设置页「获取列表」用）：
 * 返回每个模型的 id 与网关给出的元信息（上下文窗口 / 多模态 / 是否支持推理），
 * 前端据此渲染「可点击添加」的模型清单，并预填能力开关。
 */
export async function fetchGatewayModelList(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<Array<{ id: string } & GatewayModelInfo>> {
  const details = await fetchModelDetails(opts);
  const providerId = opts.providerId ?? activeProvider()?.id;
  if (providerId) {
    const merged = modelInfoCache.get(providerId) ?? new Map<string, GatewayModelInfo>();
    for (const [k, v] of details) merged.set(k, { ...(merged.get(k) ?? {}), ...v });
    modelInfoCache.set(providerId, merged);
  }
  return [...details.entries()]
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 兼容旧调用：只要模型 id 列表 */
export async function fetchGatewayModels(opts: { baseURL?: string; apiKey?: string; providerId?: string; protocol?: unknown }): Promise<string[]> {
  return (await fetchGatewayModelList(opts)).map((m) => m.id);
}
