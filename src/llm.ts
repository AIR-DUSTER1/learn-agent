/**
 * llm.ts — 模型工厂函数
 *
 * 所有 demo 都用这个工厂创建「接入自定义网关的 Chat 模型」。
 * 支持四种请求协议（config.protocol，多用于中转站的多协议路由）：
 *
 *   - openai（默认）      OpenAI Chat Completions —— ChatOpenAI，{baseURL}/chat/completions
 *   - openai-responses    OpenAI Responses API    —— ChatOpenAI(useResponsesApi)，{baseURL}/responses
 *   - anthropic           Anthropic Messages 原生 —— ChatAnthropic，{baseURL}/v1/messages
 *                         （例：DeepSeek 的 https://api.deepseek.com/anthropic）
 *   - gemini              Gemini 原生 generateContent —— ChatGoogleGenerativeAI，{baseURL}/v1beta/…
 *
 * 四个客户端都是 LangChain 的 BaseChatModel：bindTools / 流式 / 多轮消息的
 * 上层用法完全一致，图的代码（agent/*.ts）不感知协议差异。
 *
 * ★ 思考等级（reasoning / thinking）也在这里落地：
 *   config.reasoning 存的是「方言 + 档位」（见 reasoning.ts），
 *   各家的字段名与取值都不一样 ——
 *     · OpenAI 系：reasoning_effort（原生客户端里是 reasoning_effort，Responses 是 reasoning.effort）
 *     · 智谱 / DeepSeek：thinking.type（enabled / disabled）
 *     · Anthropic：thinking.budget_tokens 或 output_config.effort
 *     · Gemini：thinkingConfig.thinkingBudget / thinkingLevel
 *   所以这里按协议做一次「归一化参数 → 客户端字段」的翻译。
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config } from "./config.js";
import { resolveReasoning } from "./reasoning.js";

/** 各协议客户端的统一视图：保证 bindTools 一定存在（图的代码都依赖它） */
type ChatModelLike = BaseChatModel & {
  bindTools: NonNullable<BaseChatModel["bindTools"]>;
};

/** 本次请求要用的思考参数（未设置 / 供应商默认时为 null） */
function currentReasoning() {
  return resolveReasoning(config.reasoning, {
    baseURL: config.baseURL,
    model: config.model,
    protocol: config.protocol,
  });
}

/** 极简类型守卫：把 unknown 收窄成普通对象 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * 协议与方言不匹配时的「近似换算」（用户手动把 OpenAI 方言配在 Anthropic 协议上等）。
 * 与其静默丢掉参数，不如按下面这张对应表翻译成目标协议认识的写法，
 * 并在设置页给出提示（见 app.js 的 renderLevelSelect）。
 *   reasoning_effort:  none/minimal → 关思考或最小预算，low/medium/high/xhigh/max → 逐级加大
 *   thinking.type:     disabled → 关思考，enabled/adaptive → 由模型自适应
 */
const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** reasoning_effort → Anthropic 扩展思考预算（tokens） */
function effortToAnthropicBudget(effort: string): number {
  switch (effort) {
    case "none": return 0;
    case "minimal": return 1024;
    case "low": return 4096;
    case "medium": return 8192;
    case "high": return 16384;
    default: return 32000; // xhigh / max
  }
}

/** reasoning_effort → Gemini 思考等级 */
function effortToGeminiLevel(effort: string): "LOW" | "MEDIUM" | "HIGH" {
  const idx = EFFORT_LADDER.indexOf(effort as (typeof EFFORT_LADDER)[number]);
  if (idx <= 2) return "LOW";       // none / minimal / low
  if (idx === 3) return "MEDIUM";   // medium
  return "HIGH";                    // high / xhigh / max
}

/** 把 snake_case 的思考参数转成 Gemini 客户端要的 camelCase thinkingConfig */
function toGeminiThinkingConfig(raw: unknown): { thinkingBudget?: number; thinkingLevel?: "THINKING_LEVEL_UNSPECIFIED" | "LOW" | "MEDIUM" | "HIGH"; includeThoughts?: boolean } | undefined {
  const src = asRecord(raw);
  if (!src) return undefined;
  const out: { thinkingBudget?: number; thinkingLevel?: "THINKING_LEVEL_UNSPECIFIED" | "LOW" | "MEDIUM" | "HIGH"; includeThoughts?: boolean } = {};
  if (typeof src.thinking_budget === "number") out.thinkingBudget = src.thinking_budget;
  if (typeof src.thinking_budget === "string" && src.thinking_budget.trim() !== "" && Number.isFinite(Number(src.thinking_budget))) {
    out.thinkingBudget = Number(src.thinking_budget);
  }
  if (typeof src.thinking_level === "string") {
    const level = src.thinking_level.toUpperCase();
    if (level === "LOW" || level === "MEDIUM" || level === "HIGH" || level === "THINKING_LEVEL_UNSPECIFIED") out.thinkingLevel = level;
  }
  if (typeof src.include_thoughts === "boolean") out.includeThoughts = src.include_thoughts;
  return Object.keys(out).length ? out : undefined;
}

/** 非 Gemini 方言 → Gemini 的 thinkingConfig（近似换算，保证档位不白选） */
function fallbackGeminiConfig(params: Record<string, unknown>): { thinkingBudget?: number; thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" } | undefined {
  const effort = params.reasoning_effort;
  if (typeof effort === "string") {
    if (effort === "none") return { thinkingBudget: 0 };
    return { thinkingLevel: effortToGeminiLevel(effort) };
  }
  const thinking = asRecord(params.thinking);
  if (thinking?.type === "disabled") return { thinkingBudget: 0 };
  if (thinking?.type === "enabled" || thinking?.type === "adaptive") return { thinkingBudget: -1 };
  return undefined;
}

/**
 * 创建一个可对话的 Chat 模型实例。
 *
 * @param temperature 采样温度：0 表示尽量确定性输出（适合工具调用 demo）
 */
export function createChatModel(temperature = 0): ChatModelLike {
  // 各客户端都要求 Key 非空；留空时给占位符，让网关给出真实的鉴权错误
  const apiKey = config.apiKey || "missing-key";
  const reasoning = currentReasoning();
  const params = reasoning.params ?? {};
  const { reasoning_effort: reasoningEffort, ...rest } = params as { reasoning_effort?: unknown } & Record<string, unknown>;

  switch (config.protocol) {
    case "anthropic": {
      // Anthropic：thinking（扩展思考）/ output_config.effort 是客户端的构造参数，不走请求体透传
      const thinkingRaw = asRecord(params.thinking);
      const outputConfig = asRecord(params.output_config);
      let thinking = thinkingRaw;
      // 兼容换算：方言给的是 reasoning_effort（OpenAI 系写法）时，按强度换算成扩展思考预算，
      // 否则这个档位在 Messages 接口上会被静默忽略
      if (!thinking && typeof reasoningEffort === "string") {
        const budget = effortToAnthropicBudget(reasoningEffort);
        thinking = budget > 0 ? { type: "enabled", budget_tokens: budget } : { type: "disabled" };
      }
      const budget = typeof thinking?.budget_tokens === "number" ? thinking.budget_tokens : undefined;
      const thinkingEnabled = thinking?.type === "enabled" || thinking?.type === "adaptive";
      // Anthropic 要求「开启思考时 temperature 必须为 1」，且 budget_tokens < max_tokens
      const maxTokens = budget ? Math.max(8192, budget + 4096) : 8192;
      return new ChatAnthropic({
        model: config.model,
        apiKey,
        ...(thinkingEnabled ? {} : { temperature }),
        maxRetries: 2,
        maxTokens,
        ...(thinking ? { thinking: thinking as { type: "enabled"; budget_tokens: number } | { type: "disabled" } } : {}),
        ...(outputConfig?.effort ? { outputConfig: { effort: outputConfig.effort as "low" | "medium" | "high" | "xhigh" | "max" } } : {}),
        ...(config.baseURL ? { anthropicApiUrl: config.baseURL } : {}),
      }) as unknown as ChatModelLike;
    }

    case "gemini": {
      // 原生 thinking_config 直接用；其它方言（OpenAI / 智谱…）按近似换算成 thinkingLevel/thinkingBudget
      const thinkingConfig = toGeminiThinkingConfig(params.thinking_config) ?? fallbackGeminiConfig(params);
      return new ChatGoogleGenerativeAI({
        model: config.model,
        apiKey,
        temperature,
        maxRetries: 2,
        ...(thinkingConfig ? { thinkingConfig } : {}),
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }) as unknown as ChatModelLike;
    }

    case "openai-responses":
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        temperature,
        maxRetries: 2,
        useResponsesApi: true,
        // Responses API 的思考强度字段叫 reasoning.effort（不是 reasoning_effort）
        ...(params && Object.keys(params).length
          ? { modelKwargs: { ...rest, ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}) } }
          : {}),
        ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}),
      }) as unknown as ChatModelLike;

    case "openai":
    default:
      return new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        temperature,
        maxRetries: 2,
        // 归一化参数原样进请求体：reasoning_effort / thinking / enable_thinking …
        // （ChatOpenAI 会把 modelKwargs 展开进 /chat/completions 的 payload）
        ...(params && Object.keys(params).length ? { modelKwargs: params } : {}),
        configuration: {
          // 关键：指向自定义网关地址（OpenAI 兼容格式）
          baseURL: config.baseURL,
        },
      });
  }
}
