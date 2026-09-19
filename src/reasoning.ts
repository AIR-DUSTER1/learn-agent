/**
 * ============================================================
 * reasoning.ts — 「模型思考等级」的供应商适配层
 * ============================================================
 * 为什么单独一个文件？
 *   思考等级（reasoning / thinking）**没有统一标准**：每家供应商对
 *   「思考多深」的划分方式完全不同 ——
 *
 *     · OpenAI（GPT-5 / o 系）：reasoning_effort = none|minimal|low|medium|high|xhigh
 *     · 智谱 GLM：thinking.type = enabled|disabled（开关型，默认就开着）
 *     · DeepSeek：thinking.type 开关 + reasoning_effort 强度档
 *     · Anthropic：thinking.budget_tokens 预算（4k/8k/16k…）或 output_config.effort
 *     · Gemini：thinkingConfig.thinkingBudget（token 数）或 thinkingLevel（LOW/MEDIUM/HIGH）
 *     · 通义千问 Qwen：enable_thinking + thinking_budget
 *
 *   所以这里把「等级」抽象成 **方言（dialect）+ 档位（level）**：
 *   方言描述某个供应商/协议怎么划分思考等级，档位是一句人话 + 它翻译出的
 *   请求参数。前端只跟档位打交道（下拉选项由方言动态给出），
 *   llm.ts 只跟参数打交道 —— 加一家新供应商 = 在这里多写一个方言。
 *
 * 三个来源保证参数不是拍脑袋写的（本仓库实测/官方 SDK 类型）：
 *   - DeepSeek：`.setting/probe-reasoning-levels.mjs` 实测思考参数生效；
 *   - OpenAI：node_modules/openai 的 Shared.ReasoningEffort 联合类型；
 *   - Anthropic / Gemini：@langchain/anthropic、@langchain/google-genai 的类型定义。
 */
import type { Protocol } from "./config.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type ReasoningDialectId =
  | "none"
  | "openai-effort"
  | "zhipu-thinking"
  | "deepseek-thinking"
  | "anthropic-budget"
  | "anthropic-effort"
  | "gemini-budget"
  | "gemini-level"
  | "qwen-thinking"
  | "custom";

/** 一个档位：人话描述 + 它翻译出的请求参数（null = 不发送任何参数） */
export interface ReasoningLevel {
  id: string;
  label: string;
  desc: string;
  /**
   * 归一化的请求参数（用各家 API 的原始字段名，snake_case）。
   * 例如 { reasoning_effort: "high" } / { thinking: { type: "disabled" } }。
   * llm.ts 按协议把它交给对应的 LangChain 客户端（OpenAI 走请求体，
   * Anthropic / Gemini 走各自的构造参数）。
   */
  params: Record<string, unknown> | null;
}

/** 一种「思考等级划分方式」= 供应商方言 */
export interface ReasoningDialect {
  id: ReasoningDialectId;
  label: string;
  vendor: string;
  /** 该方言在请求体里用的字段（展示用） */
  field: string;
  /** 划分方式的一句话说明（展示在设置页，帮用户理解「为什么每家不一样」） */
  scheme: string;
  /** 只在某些协议下才有意义的方言（不填 = 都适用） */
  protocols?: Protocol[];
  levels: ReasoningLevel[];
}

/** 落盘到 .web-config.json 的思考等级设置（跟着「模型」走，不跟供应商走） */
export interface ReasoningSetting {
  /** "auto" = 按 baseURL / 模型名 / 协议自动识别方言 */
  dialect: ReasoningDialectId | "auto";
  /** 档位 id；"default" 表示不干预，交给供应商默认值 */
  level: string;
  /** dialect = "custom" 时用户直接填的 JSON 片段 */
  custom?: string;
}

export const DEFAULT_REASONING: ReasoningSetting = { dialect: "auto", level: "default" };

const NOOP_LEVEL: ReasoningLevel = {
  id: "default",
  label: "供应商默认",
  desc: "不发送任何思考参数，完全交给网关 / 模型自己的默认行为",
  params: null,
};

// ---------------------------------------------------------------------------
// 方言表
// ---------------------------------------------------------------------------
export const DIALECTS: ReasoningDialect[] = [
  {
    id: "none",
    label: "不设置（通用兼容）",
    vendor: "任意",
    field: "—",
    scheme: "不发送任何思考参数：兼容所有网关（含不认识思考参数的中转站），用模型自己的默认行为。",
    levels: [NOOP_LEVEL],
  },
  {
    id: "openai-effort",
    label: "OpenAI 思考强度档",
    vendor: "OpenAI（GPT-5 / o 系）",
    field: "reasoning_effort",
    scheme: "OpenAI 按「强度档」线性划分：none → minimal → low → medium → high → xhigh，档位越高越慢越贵但推理越深。",
    levels: [
      NOOP_LEVEL,
      { id: "none", label: "不思考 (none)", desc: "完全关闭推理，等同于普通对话模型", params: { reasoning_effort: "none" } },
      { id: "minimal", label: "极低 (minimal)", desc: "只做最少推理，响应最快（GPT-5 起的档位）", params: { reasoning_effort: "minimal" } },
      { id: "low", label: "低 (low)", desc: "轻量推理，适合简单问答与工具调用", params: { reasoning_effort: "low" } },
      { id: "medium", label: "中 (medium)", desc: "均衡档，官方常用默认值", params: { reasoning_effort: "medium" } },
      { id: "high", label: "高 (high)", desc: "深度推理，适合复杂编程 / 数学", params: { reasoning_effort: "high" } },
      { id: "xhigh", label: "极高 (xhigh)", desc: "更高预算（GPT-5.1 系新增）", params: { reasoning_effort: "xhigh" } },
      { id: "max", label: "最高 (max)", desc: "该字段允许的最大值（部分网关 / 新版模型支持）", params: { reasoning_effort: "max" } },
    ],
  },
  {
    id: "zhipu-thinking",
    label: "智谱 GLM 深度思考开关",
    vendor: "智谱 AI（GLM-4.5 / 4.6 / 5）",
    field: "thinking.type",
    scheme: "智谱按「开关」划分：只有 enabled / disabled 两态（GLM-4.5 起默认开启深度思考，关掉即退化成普通对话速度）。",
    levels: [
      NOOP_LEVEL,
      { id: "enabled", label: "开启深度思考", desc: "thinking.type = enabled，让 GLM 先推理再回答", params: { thinking: { type: "enabled" } } },
      { id: "disabled", label: "关闭深度思考", desc: "thinking.type = disabled，响应更快、不再返回思考过程", params: { thinking: { type: "disabled" } } },
    ],
  },
  {
    id: "deepseek-thinking",
    label: "DeepSeek 思考开关 + 强度",
    vendor: "DeepSeek 官方",
    field: "thinking.type / reasoning_effort",
    scheme:
      "DeepSeek 是「开关 + 强度」两层：thinking.type 决定要不要思考（disabled 后响应里不再有 reasoning_content），" +
      "reasoning_effort 再细分 minimal → low → medium → high → max 五档强度。",
    levels: [
      NOOP_LEVEL,
      { id: "disabled", label: "关闭思考", desc: "thinking.type = disabled，直接给答案（实测 reasoning_content 为空）", params: { thinking: { type: "disabled" } } },
      { id: "enabled", label: "开启思考（默认强度）", desc: "thinking.type = enabled，显式打开思考模式", params: { thinking: { type: "enabled" } } },
      { id: "minimal", label: "强度·极低 (minimal)", desc: "reasoning_effort = minimal", params: { reasoning_effort: "minimal" } },
      { id: "low", label: "强度·低 (low)", desc: "reasoning_effort = low，简单任务够用", params: { reasoning_effort: "low" } },
      { id: "medium", label: "强度·中 (medium)", desc: "reasoning_effort = medium，均衡档", params: { reasoning_effort: "medium" } },
      { id: "high", label: "强度·高 (high)", desc: "reasoning_effort = high，复杂任务推荐", params: { reasoning_effort: "high" } },
      { id: "max", label: "强度·最高 (max)", desc: "reasoning_effort = max，最深的推理预算", params: { reasoning_effort: "max" } },
    ],
  },
  {
    id: "anthropic-budget",
    label: "Anthropic 扩展思考预算",
    vendor: "Anthropic（Claude 经典）",
    field: "thinking.budget_tokens",
    scheme: "Anthropic 的扩展思考按「token 预算」划分：budget_tokens 给多少 token 让模型思考（预算必须小于 max_tokens）。",
    protocols: ["anthropic"],
    levels: [
      NOOP_LEVEL,
      { id: "disabled", label: "关闭思考", desc: "thinking.type = disabled", params: { thinking: { type: "disabled" } } },
      { id: "budget-2048", label: "轻量（2k tokens）", desc: "budget_tokens = 2048，简单任务", params: { thinking: { type: "enabled", budget_tokens: 2048 } } },
      { id: "budget-8192", label: "标准（8k tokens）", desc: "budget_tokens = 8192，日常默认", params: { thinking: { type: "enabled", budget_tokens: 8192 } } },
      { id: "budget-16384", label: "深入（16k tokens）", desc: "budget_tokens = 16384，复杂推理", params: { thinking: { type: "enabled", budget_tokens: 16384 } } },
      { id: "budget-32000", label: "极限（32k tokens）", desc: "budget_tokens = 32000，需要模型支持且 max_tokens 足够大", params: { thinking: { type: "enabled", budget_tokens: 32000 } } },
      { id: "adaptive", label: "自适应额度", desc: "thinking.type = adaptive（由模型自行决定思考深度，新版 Claude）", params: { thinking: { type: "adaptive" } } },
    ],
  },
  {
    id: "anthropic-effort",
    label: "Anthropic 输出强度档",
    vendor: "Anthropic（新版 effort）",
    field: "output_config.effort",
    scheme: "Anthropic 新版按「输出强度」划分：output_config.effort = low → medium → high → xhigh → max，控制回答的详尽程度与 token 消耗。",
    protocols: ["anthropic"],
    levels: [
      NOOP_LEVEL,
      { id: "low", label: "低 (low)", desc: "output_config.effort = low，省 token、响应快", params: { output_config: { effort: "low" } } },
      { id: "medium", label: "中 (medium)", desc: "output_config.effort = medium", params: { output_config: { effort: "medium" } } },
      { id: "high", label: "高 (high)", desc: "output_config.effort = high", params: { output_config: { effort: "high" } } },
      { id: "xhigh", label: "极高 (xhigh)", desc: "output_config.effort = xhigh", params: { output_config: { effort: "xhigh" } } },
      { id: "max", label: "最高 (max)", desc: "output_config.effort = max，最详尽的输出", params: { output_config: { effort: "max" } } },
    ],
  },
  {
    id: "gemini-budget",
    label: "Gemini 思考预算",
    vendor: "Google Gemini 2.5",
    field: "thinkingConfig.thinkingBudget",
    scheme: "Gemini 2.5 按「token 预算」划分：0 = 关闭思考，-1 = 动态自适应，正数 = 给多少 token 思考。",
    protocols: ["gemini"],
    levels: [
      NOOP_LEVEL,
      { id: "off", label: "关闭思考 (0)", desc: "thinkingBudget = 0", params: { thinking_config: { thinking_budget: 0 } } },
      { id: "dynamic", label: "动态自适应 (-1)", desc: "thinkingBudget = -1，由模型决定想多久", params: { thinking_config: { thinking_budget: -1 } } },
      { id: "budget-1024", label: "轻量（1024）", desc: "thinkingBudget = 1024", params: { thinking_config: { thinking_budget: 1024 } } },
      { id: "budget-8192", label: "标准（8192）", desc: "thinkingBudget = 8192", params: { thinking_config: { thinking_budget: 8192 } } },
      { id: "budget-24576", label: "深入（24576）", desc: "thinkingBudget = 24576，复杂推理", params: { thinking_config: { thinking_budget: 24576 } } },
    ],
  },
  {
    id: "gemini-level",
    label: "Gemini 思考等级",
    vendor: "Google Gemini 3",
    field: "thinkingConfig.thinkingLevel",
    scheme: "Gemini 3 改用「等级」划分：thinkingLevel = LOW / MEDIUM / HIGH（不再给具体 token 数）。",
    protocols: ["gemini"],
    levels: [
      NOOP_LEVEL,
      { id: "low", label: "低 (LOW)", desc: "thinkingLevel = LOW，延迟优先", params: { thinking_config: { thinking_level: "LOW" } } },
      { id: "medium", label: "中 (MEDIUM)", desc: "thinkingLevel = MEDIUM", params: { thinking_config: { thinking_level: "MEDIUM" } } },
      { id: "high", label: "高 (HIGH)", desc: "thinkingLevel = HIGH，推理能力优先", params: { thinking_config: { thinking_level: "HIGH" } } },
    ],
  },
  {
    id: "qwen-thinking",
    label: "通义千问 思考开关 / 预算",
    vendor: "阿里云百炼（Qwen3）",
    field: "enable_thinking / thinking_budget",
    scheme: "Qwen3 用 enable_thinking 开关 + thinking_budget 预算（混合思考模型默认开启思考）。",
    levels: [
      NOOP_LEVEL,
      { id: "on", label: "开启思考", desc: "enable_thinking = true", params: { enable_thinking: true } },
      { id: "off", label: "关闭思考 (non-thinking)", desc: "enable_thinking = false，走非思考模式", params: { enable_thinking: false } },
      { id: "budget-1024", label: "思考预算 1k", desc: "thinking_budget = 1024", params: { enable_thinking: true, thinking_budget: 1024 } },
      { id: "budget-8192", label: "思考预算 8k", desc: "thinking_budget = 8192", params: { enable_thinking: true, thinking_budget: 8192 } },
      { id: "budget-32768", label: "思考预算 32k", desc: "thinking_budget = 32768", params: { enable_thinking: true, thinking_budget: 32768 } },
    ],
  },
  {
    id: "custom",
    label: "自定义 JSON（中转站 / 私有字段）",
    vendor: "任意（手写）",
    field: "自定义",
    scheme: "直接把你网关需要的字段写成 JSON（例如 { \"reasoning\": { \"effort\": \"high\" } }），会原样合并进请求体。",
    levels: [
      NOOP_LEVEL,
      { id: "custom", label: "使用下面的自定义 JSON", desc: "逐字合并进请求体，字段名以你网关的文档为准", params: null },
    ],
  },
];

const DIALECT_MAP = new Map(DIALECTS.map((d) => [d.id, d]));

export function getDialect(id: string | undefined): ReasoningDialect {
  return DIALECT_MAP.get((id ?? "") as ReasoningDialectId) ?? DIALECT_MAP.get("none")!;
}

export function getLevel(dialectId: string | undefined, levelId: string | undefined): ReasoningLevel {
  const dialect = getDialect(dialectId);
  return dialect.levels.find((l) => l.id === levelId) ?? dialect.levels[0];
}

/** 是否是一个合法的方言 id（含 "auto"） */
export function isDialectId(v: unknown): v is ReasoningDialectId | "auto" {
  return v === "auto" || (typeof v === "string" && DIALECT_MAP.has(v as ReasoningDialectId));
}

// ---------------------------------------------------------------------------
// 自动识别方言：按 baseURL 主机 → 模型名 → 协议的顺序猜
// ---------------------------------------------------------------------------
const HOST_RULES: Array<{ test: RegExp; dialect: ReasoningDialectId }> = [
  { test: /(^|\.)bigmodel\.cn$|(^|\.)z\.ai$/i, dialect: "zhipu-thinking" },
  { test: /(^|\.)deepseek\.com$/i, dialect: "deepseek-thinking" },
  { test: /(^|\.)openai\.com$/i, dialect: "openai-effort" },
  { test: /(^|\.)anthropic\.com$/i, dialect: "anthropic-effort" },
  { test: /(^|\.)googleapis\.com$/i, dialect: "gemini-level" },
  { test: /(^|\.)aliyuncs\.com$|dashscope/i, dialect: "qwen-thinking" },
];

const MODEL_RULES: Array<{ test: RegExp; dialect: ReasoningDialectId }> = [
  { test: /^glm|zhipu|charglm|codegeex/i, dialect: "zhipu-thinking" },
  { test: /^deepseek|^ds-/i, dialect: "deepseek-thinking" },
  { test: /^gpt-5|^gpt5|^o[1-9]|^o4|^codex|^gpt-oss/i, dialect: "openai-effort" },
  { test: /^claude/i, dialect: "anthropic-effort" },
  { test: /^gemini-3/i, dialect: "gemini-level" },
  { test: /^gemini/i, dialect: "gemini-budget" },
  { test: /^qwen/i, dialect: "qwen-thinking" },
];

/**
 * 猜测某个「供应商 + 模型」该用哪种思考等级划分。
 *
 * 两条原则：
 *   1) **协议优先**：Anthropic Messages / Gemini 原生接口的思考参数跟 OpenAI 系
 *      完全不是一回事，所以 anthropic 协议下只会在 Anthropic 方言里挑
 *      （Claude 官方 → effort；其它走 Anthropic 兼容的网关 → budget_tokens 预算，
 *      这是兼容性最好的写法）；gemini 协议同理。
 *   2) 猜错不致命：档位默认是「供应商默认」（不发送任何参数），
 *      只有用户真的选了一个档位才会往请求里塞字段。
 */
export function detectDialect(opts: { baseURL?: string; model?: string; protocol?: Protocol }): ReasoningDialectId {
  const protocol = opts.protocol ?? "openai";
  let host = "";
  try {
    host = new URL(opts.baseURL ?? "").hostname;
  } catch {
    host = "";
  }
  const hostHit = HOST_RULES.find((r) => r.test.test(host))?.dialect;
  const modelHit = MODEL_RULES.find((r) => r.test.test(opts.model ?? ""))?.dialect;
  const hit = hostHit ?? modelHit;

  if (protocol === "anthropic") {
    // 只有 Anthropic 自己的方言能在 Messages 接口上原样生效
    if (hit === "anthropic-effort" || hit === "anthropic-budget") return hit;
    return "anthropic-budget"; // Claude 兼容网关的通用写法：thinking.budget_tokens
  }
  if (protocol === "gemini") {
    if (hit === "gemini-level" || hit === "gemini-budget") return hit;
    return "gemini-level"; // Gemini 3 起的通用写法：thinkingConfig.thinkingLevel
  }
  // OpenAI 系（Chat Completions / Responses）：Anthropic、Gemini 专属方言不适用
  if (hit && hit !== "anthropic-effort" && hit !== "anthropic-budget" && hit !== "gemini-level" && hit !== "gemini-budget") {
    return hit;
  }
  return "none";
}

/** 把设置里的 "auto" 解析成真正的方言 id */
export function resolveDialect(setting: ReasoningSetting | undefined, opts: { baseURL?: string; model?: string; protocol?: Protocol }): ReasoningDialectId {
  const dialect = setting?.dialect ?? "auto";
  if (dialect === "auto") return detectDialect(opts);
  return dialect;
}

// ---------------------------------------------------------------------------
// 档位 → 请求参数
// ---------------------------------------------------------------------------
export interface ResolvedReasoning {
  dialect: ReasoningDialectId;
  level: string;
  /** 归一化参数（null = 不发送） */
  params: Record<string, unknown> | null;
  /** 展示用短标签，例如「思考·高 (high)」「关闭思考」「供应商默认」 */
  label: string;
  /** 自定义 JSON 解析失败时的提示（前端会红字显示） */
  error?: string;
}

function parseCustom(json: string | undefined): { params: Record<string, unknown> | null; error?: string } {
  const text = (json ?? "").trim();
  if (!text) return { params: null };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { params: null, error: "自定义 JSON 必须是一个对象，例如 {\"reasoning\":{\"effort\":\"high\"}}" };
    }
    return { params: parsed as Record<string, unknown> };
  } catch (err) {
    return { params: null, error: `自定义 JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 解析出「这次请求到底要发什么思考参数」 */
export function resolveReasoning(
  setting: ReasoningSetting | undefined,
  ctx: { baseURL?: string; model?: string; protocol?: Protocol }
): ResolvedReasoning {
  const dialectId = resolveDialect(setting, ctx);
  const dialect = getDialect(dialectId);
  const levelId = setting?.level && setting.level !== "" ? setting.level : "default";
  const level = getLevel(dialectId, levelId);

  if (dialectId === "custom") {
    const { params, error } = parseCustom(setting?.custom);
    return {
      dialect: dialectId,
      level: levelId,
      params,
      label: params ? "自定义参数" : "供应商默认",
      error,
    };
  }

  return {
    dialect: dialectId,
    level: level.id,
    params: level.params,
    label: level.id === "default" ? "供应商默认" : level.label,
  };
}
