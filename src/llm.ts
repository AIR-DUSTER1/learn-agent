/**
 * llm.ts — 模型工厂函数
 *
 * 所有 demo 都用这个工厂创建「接入自定义网关的 Chat 模型」。
 * 核心技巧：@langchain/openai 的 ChatOpenAI 支持传入 configuration.baseURL，
 * 因此任何「OpenAI Chat Completions 兼容」的网关（中转站、本地 vLLM 等）
 * 都可以直接接入，不需要特定的供应商 SDK。
 */
import { ChatOpenAI } from "@langchain/openai";
import { config } from "./config.js";

/**
 * 创建一个可对话的 Chat 模型实例。
 *
 * @param temperature 采样温度：0 表示尽量确定性输出（适合工具调用 demo）
 */
export function createChatModel(temperature = 0): ChatOpenAI {
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
