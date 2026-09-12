/**
 * config.ts — 统一读取 .env 中的网关配置
 *
 * 为什么要单独抽一个文件？
 * 所有 demo 共用一个「自定义 OpenAI 兼容网关」，把 baseURL / apiKey / model
 * 集中在这里管理，方便你在不修改任何 agent 代码的情况下切换供应商或模型。
 *
 * ★ config 是「运行时可变」的（没有 as const）：
 *   - CLI 场景：启动后无人修改它，值 === .env；
 *   - Web 场景：src/server/settings.ts 会在启动时叠加本地覆盖文件
 *     （.web-config.json），并允许在设置页里在线修改 —— 建图时
 *     （llm.ts 的 createChatModel）读取的永远是当前值。
 */
import "dotenv/config";

export const config = {
  /** 兼容 OpenAI 格式的 API 地址（例如 https://tokenrhythm.studio/v1） */
  baseURL: process.env.BASE_URL ?? "https://tokenrhythm.studio/v1",

  /** API Key */
  apiKey: process.env.API_KEY ?? "",

  /** 模型名。运行 `npm run models` 可查看网关支持的模型列表 */
  model: process.env.MODEL ?? "gpt-4o-mini",

  /**
   * 请求协议（多用于中转站的多协议路由）：
   *   - "openai"           OpenAI Chat Completions（默认，{baseURL}/chat/completions）
   *   - "openai-responses" OpenAI Responses API（{baseURL}/responses）
   *   - "anthropic"        Anthropic Messages 原生（{baseURL}/v1/messages，
   *                        例：DeepSeek 的 https://api.deepseek.com/anthropic）
   *   - "gemini"           Gemini 原生 generateContent（{baseURL}/v1beta/...）
   */
  protocol: process.env.AI_PROTOCOL ?? "openai",
} as { baseURL: string; apiKey: string; model: string; protocol: Protocol };

export type Protocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export const PROTOCOLS: Protocol[] = ["openai", "openai-responses", "anthropic", "gemini"];

/** 协议合法性校验（settings 落盘前用） */
export function isProtocol(v: unknown): v is Protocol {
  return typeof v === "string" && (PROTOCOLS as string[]).includes(v);
}

/** 启动前校验配置是否齐全，缺 Key 时给出明确提示并退出 */
export function assertConfig(): void {
  if (!config.apiKey) {
    console.error(
      "[config] 缺少 API_KEY。\n" +
        "  请复制 .env.example 为 .env 并填入你的 API Key，或设置环境变量 API_KEY。\n" +
        "  （Web 界面也可以在设置页里在线填写：npm run web → 右上角 ⚙ 设置）"
    );
    process.exit(1);
  }
  if (!config.baseURL) {
    console.error("[config] 缺少 BASE_URL（OpenAI 兼容网关地址）。");
    process.exit(1);
  }
  console.log(
    `[config] 网关: ${config.baseURL}  模型: ${config.model}\n`
  );
}
