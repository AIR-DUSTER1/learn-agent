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
 */
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { config } from "./config.js";

/** 各协议客户端的统一视图：保证 bindTools 一定存在（图的代码都依赖它） */
type ChatModelLike = BaseChatModel & {
  bindTools: NonNullable<BaseChatModel["bindTools"]>;
};

/**
 * 创建一个可对话的 Chat 模型实例。
 *
 * @param temperature 采样温度：0 表示尽量确定性输出（适合工具调用 demo）
 */
export function createChatModel(temperature = 0): ChatModelLike {
  // 各客户端都要求 Key 非空；留空时给占位符，让网关给出真实的鉴权错误
  const apiKey = config.apiKey || "missing-key";

  switch (config.protocol) {
    case "anthropic":
      // anthropicApiUrl = 自定义网关根地址，客户端会请求 {anthropicApiUrl}/v1/messages
      return new ChatAnthropic({
        model: config.model,
        apiKey,
        temperature,
        maxRetries: 2,
        maxTokens: 8192,
        ...(config.baseURL ? { anthropicApiUrl: config.baseURL } : {}),
      }) as unknown as ChatModelLike;

    case "gemini":
      return new ChatGoogleGenerativeAI({
        model: config.model,
        apiKey,
        temperature,
        maxRetries: 2,
        ...(config.baseURL ? { baseUrl: config.baseURL } : {}),
      }) as unknown as ChatModelLike;

    case "openai-responses":
      return new ChatOpenAI({
        model: config.model,
        apiKey,
        temperature,
        maxRetries: 2,
        useResponsesApi: true,
        ...(config.baseURL ? { configuration: { baseURL: config.baseURL } } : {}),
      }) as unknown as ChatModelLike;

    case "openai":
    default:
      return new ChatOpenAI({
        model: config.model,
        apiKey: config.apiKey,
        temperature,
        maxRetries: 2,
        configuration: {
          // 关键：指向自定义网关地址（OpenAI 兼容格式）
          baseURL: config.baseURL,
        },
      });
  }
}
