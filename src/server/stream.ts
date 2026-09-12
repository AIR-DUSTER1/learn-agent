/**
 * ============================================================
 * stream.ts — 把 LangGraph 原始流事件「翻译」成前端友好的 AgentEvent
 * ============================================================
 * 实测（LangGraph JS v1.x）streamMode: ["messages","updates"] 的事件形状：
 *
 *   ["messages",  [ chunk, metadata ]]     ← 模型 token / 整条 ToolMessage
 *   ["updates",   { 节点名: { messages: [...] } }]
 *   ["updates",   { __interrupt__: [{ value: 审批载荷 }] }]
 *
 * 关键结论（均有探针脚本实测）：
 *   1. messages 模式会把子图里的消息也「冒泡」上来，
 *      metadata.langgraph_node 是内层节点名，checkpoint_ns 前缀是父节点名；
 *   2. ToolMessage 在 messages 模式里是「整条」出现，带 tool_call_id 可配对；
 *   3. 子图的 updates 会把进入子图前的整段历史再回显一遍 ——
 *      这里按消息 id 去重（流式 chunk 与最终消息共享同一个 id），杜绝重复渲染。
 */
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentEvent, ApprovalPayload } from "./events.js";

/** 任意 graph.stream() 可用对象（4 个 demo 的图节点名互不相同，泛型互斥，鸭子类型即可） */
type AnyGraph = {
  stream: (input: unknown, options: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
};

interface NormalizeOptions {
  threadId: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把消息 content（string 或 内容块数组）拍平成纯文本 */
function contentText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/**
 * 从 AI 消息 / 流式 chunk 里提取 token 用量。
 * 标准路径是 usage_metadata（@langchain/openai 由网关的 usage 字段映射而来，
 * input_token_details.cache_read 即「提示词缓存命中」）；
 * 再兜底兼容 response_metadata.tokenUsage / additional_kwargs.tokenUsage 旧形状。
 *
 * 注意流式分片：Anthropic 系网关在 message_start 只给 input_tokens（output=0），
 * 最终 output_tokens 在后面的 message_delta 里且不含 input —— 所以调用方必须
 * 按「节点内累积合并」处理本函数的分片结果（见 runGraphEvents 的 usageAccum）。
 */
function extractUsage(msg: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
} | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as {
    usage_metadata?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_token_details?: { cache_read?: number };
    };
    response_metadata?: { tokenUsage?: Record<string, unknown> };
    additional_kwargs?: { tokenUsage?: Record<string, unknown> };
  };
  const um = m.usage_metadata;
  if (um && (typeof um.input_tokens === "number" || typeof um.output_tokens === "number")) {
    return {
      inputTokens: um.input_tokens,
      outputTokens: um.output_tokens,
      totalTokens: um.total_tokens,
      cacheReadTokens: um.input_token_details?.cache_read,
    };
  }
  const tu = (m.response_metadata?.tokenUsage ?? m.additional_kwargs?.tokenUsage) as
    | { promptTokens?: number; prompt_tokens?: number; completionTokens?: number; completion_tokens?: number; totalTokens?: number; total_tokens?: number; cacheReadTokens?: number; cache_read?: number }
    | undefined;
  const input = tu?.promptTokens ?? tu?.prompt_tokens;
  const output = tu?.completionTokens ?? tu?.completion_tokens;
  if (typeof input === "number" && input > 0) {
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: tu?.totalTokens ?? tu?.total_tokens ?? input + (output ?? 0),
      cacheReadTokens: tu?.cacheReadTokens ?? tu?.cache_read,
    };
  }
  if (typeof output === "number" && output > 0) {
    return { outputTokens: output };
  }
  return null;
}

/** 用量分片合并：分片里的 0 值 / 缺失字段不覆盖已有值（Anthropic 末片 input=0、首片 output=0） */
function mergeUsage(
  acc: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number } | null,
  next: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number } | null
) {
  if (!next) return acc;
  const pick = (a: number | undefined, b: number | undefined) =>
    b !== undefined && b > 0 ? b : a ?? 0;
  const input = pick(acc?.inputTokens, next.inputTokens);
  const output = pick(acc?.outputTokens, next.outputTokens);
  const total = input > 0 && output > 0 ? input + output : pick(acc?.totalTokens, next.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: pick(acc?.cacheReadTokens, next.cacheReadTokens),
  };
}

/** 从 messages 模式的 metadata 里取出可读的节点标签（子图显示为 "父节点/内层节点"） */
function nodeLabel(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const node = typeof meta.langgraph_node === "string" ? meta.langgraph_node : undefined;
  if (!node) return undefined;
  const ns = typeof meta.checkpoint_ns === "string" ? meta.checkpoint_ns : "";
  const parent = ns.split(":")[0] ?? "";
  // 顶层节点的 checkpoint_ns 前缀 === 节点名本身；不一致说明消息来自子图
  return parent && parent !== node ? `${parent}/${node}` : node;
}

/**
 * 递归展开 updates 里的嵌套消息数组（子图回显形如 { researcher: { agent: { messages } } }），
 * 返回 [节点路径, 消息] 对，任何深度都能展开。
 */
function* walkUpdateMessages(
  key: string,
  update: unknown
): Generator<[string, BaseMessage]> {
  if (!update || typeof update !== "object") return;
  if (Array.isArray((update as { messages?: unknown }).messages)) {
    for (const msg of (update as { messages: unknown[] }).messages) {
      if (msg && typeof msg === "object" && "content" in (msg as object)) {
        yield [key, msg as BaseMessage];
      }
    }
    return;
  }
  for (const [childKey, child] of Object.entries(update as Record<string, unknown>)) {
    if (child && typeof child === "object") {
      yield* walkUpdateMessages(`${key}:${childKey}`, child);
    }
  }
}

// ---------------------------------------------------------------------------
// 主转换器
// ---------------------------------------------------------------------------

/**
 * 运行一张图并把原始流事件规范化为 AgentEvent 序列（总是以 done 结尾）。
 *
 * 渲染策略：**内容只认 messages 模式，updates 模式只用来取「步骤节点 + interrupt + 兜底消息」**。
 * 这样完全避开「子图回显整段历史」造成的重复，token 流与最终消息天然不重叠。
 */
export async function* runGraphEvents(
  graph: AnyGraph,
  input: unknown,
  options: NormalizeOptions
): AsyncGenerator<AgentEvent> {
  const stream = await graph.stream(input, {
    streamMode: ["messages", "updates"],
    configurable: { thread_id: options.threadId },
    signal: options.signal,
  });

  const streamedIds = new Set<string>(); // messages 模式已流式输出过的消息 id
  let streamedSinceBoundary = false;     // 距上个「边界消息」（工具结果等）是否已有流式文本
  let toolSeq = 0;                       // 网关不给 tool_call id 时兜底编号
  const toolIds = new Map<number, string>(); // tool_call_chunks 的 index → 事件 id
  // 用量分片累积（Anthropic 系 input/output 分片到达）；切换节点时重置，避免跨节点污染
  let usageAccum: { inputTokens: number; outputTokens: number; totalTokens: number; cacheReadTokens: number } | null = null;
  let usageNode: string | undefined;

  for await (const tagged of stream) {
    if (options.signal?.aborted) return;
    if (!Array.isArray(tagged)) continue;
    const [mode, payload] = tagged as [string, unknown];

    // -------------------------------------------------------------
    // messages 模式：模型 token 流 + 整条工具消息
    // -------------------------------------------------------------
    if (mode === "messages" && Array.isArray(payload)) {
      const [msg, meta] = payload as [unknown, Record<string, unknown>];
      const node = nodeLabel(meta);

      if (msg instanceof AIMessageChunk) {
        // -- token 用量（分片累积合并；Anthropic 系 input/output 分散在多个 chunk）--
        if (node !== usageNode) { usageAccum = null; usageNode = node; }
        usageAccum = mergeUsage(usageAccum, extractUsage(msg));
        if (usageAccum) yield { type: "usage", ...usageAccum };
        // -- 文本 token --
        const text = contentText(msg.content);
        if (text) {
          streamedSinceBoundary = true;
          if (msg.id) streamedIds.add(msg.id);
          yield { type: "token", text, node };
        }
        // -- 工具调用参数流（ZCode 风格：边生成参数边渲染）--
        for (const tc of msg.tool_call_chunks ?? []) {
          let id: string;
          if (tc.id) {
            id = tc.id;
            toolIds.set(tc.index ?? -1, id);
          } else {
            id = toolIds.get(tc.index ?? -1) ?? `tool-${toolSeq++}`;
            toolIds.set(tc.index ?? -1, id);
          }
          const name = typeof tc.name === "string" && tc.name ? tc.name : undefined;
          const frag = typeof tc.args === "string" ? tc.args : tc.args ? JSON.stringify(tc.args) : "";
          if (name || frag) {
            yield { type: "tool_call", id, name, argsFragment: frag };
          }
        }
        continue;
      }

      if (msg instanceof ToolMessage) {
        // 整条工具结果（id 与 tool_call 配对）
        if (msg.id) streamedIds.add(msg.id);
        streamedSinceBoundary = false;
        yield {
          type: "tool_result",
          id: msg.tool_call_id ?? "",
          content: contentText(msg.content),
          isError: msg.status === "error",
        };
        continue;
      }
      continue;
    }

    // -------------------------------------------------------------
    // updates 模式：节点徽章 / interrupt / 兜底完整消息
    // -------------------------------------------------------------
    if (mode === "updates" && payload && typeof payload === "object") {
      for (const [nodeKey, update] of Object.entries(payload as Record<string, unknown>)) {
        if (nodeKey === "__interrupt__") {
          const list = (update as Array<{ value?: unknown }>) ?? [];
          for (const item of list) {
            const value = item?.value as ApprovalPayload | undefined;
            if (value && value.type === "approval") {
              yield { type: "interrupt", payload: value };
            }
          }
          continue;
        }
        if (!nodeKey.startsWith("__")) {
          yield { type: "node", name: nodeKey };
        }
        // 兜底：极少数网关不流式返回 token，此时从 updates 里补出完整 AI 消息
        for (const [, msg] of walkUpdateMessages(nodeKey, update)) {
          if (msg instanceof HumanMessage) continue;
          if (msg instanceof ToolMessage) {
            if (msg.id) streamedIds.add(msg.id);
            streamedSinceBoundary = false;
            yield {
              type: "tool_result",
              id: msg.tool_call_id ?? "",
              content: contentText(msg.content),
              isError: msg.status === "error",
            };
            continue;
          }
          if (msg instanceof AIMessage) {
            // 用量在去重前提取：即使这条消息因「子图回显」被跳过，它携带的用量依然有效
            if (nodeKey !== usageNode) { usageAccum = null; usageNode = nodeKey; }
            usageAccum = mergeUsage(usageAccum, extractUsage(msg));
            if (usageAccum) yield { type: "usage", ...usageAccum };
            const text = contentText(msg.content);
            if (!text) continue;
            if (msg.id && streamedIds.has(msg.id)) continue; // 已流式输出过 → 去重
            if (!msg.id && streamedSinceBoundary) continue;  // 无 id 且刚流过 → 视为回显
            if (msg.id) streamedIds.add(msg.id);
            if (msg.tool_calls?.length) {
              // 兜底场景里的工具调用：补一张静态卡片
              for (const call of msg.tool_calls) {
                yield { type: "tool_call", id: call.id ?? `tool-${toolSeq++}`, name: call.name, argsFragment: JSON.stringify(call.args ?? {}) };
              }
            }
            streamedSinceBoundary = false;
            yield { type: "ai_message", content: text, node: nodeKey.split(":")[0] };
          }
        }
      }
    }
  }

  yield { type: "done" };
}
