/**
 * ============================================================
 * events.ts — 服务端 → 前端 的「规范化事件流」协议
 * ============================================================
 * 为什么需要规范化？
 *   LangGraph 原始流事件（streamMode: messages / updates）形状复杂：
 *   元组嵌套、子图回显历史、AIMessageChunk 与完整消息混杂。
 *   后端先把原始事件「翻译」成下面这几种简单事件，前端只关心渲染，
 *   不需要理解 LangGraph 的流协议 —— 同时也天然解决了：
 *     - 子图把整段历史回显一遍的「去重」问题（服务端按消息 id 过滤）
 *     - 多模式事件（[mode, payload] 元组）的拆包问题
 *
 * 每种事件对应 ZCode 聊天界面里的一块 UI：
 *   node        → 节点执行步骤小徽章（agent / tools / researcher/agent …）
 *   token       → 助手正文流式文本（打字机效果）
 *   tool_call   → 工具调用卡片（参数随流式增量到达，边收边渲染）
 *   tool_result → 工具卡片填入结果，状态从「运行中」变「完成」
 *   interrupt   → Human-in-the-loop 审批卡片（Demo 3 的核心交互）
 *   usage       → 本轮模型调用的 token 用量（驱动上下文容量条 + 缓存占比）
 *   ai_message  → 整段助手消息兜底（极少数网关不支持 token 流时使用）
 *   error/done  → 错误提示 / 本轮流结束
 */

/** 从 hitl.ts 复用审批载荷形状（避免循环依赖，这里独立声明同构类型） */
export interface ApprovalPayload {
  type: "approval";
  toolName: string;
  description: string;
  args: Record<string, unknown>;
}

export type AgentEvent =
  /** 进入某个图节点（name 可能是 "agent" 或子图路径 "researcher/agent"） */
  | { type: "node"; name: string }
  /** 助手文本的流式增量片段 */
  | { type: "token"; text: string; node?: string }
  /**
   * 工具调用（流式）：name 首次出现时创建卡片，后续事件是参数 JSON 字符串的增量。
   * id 在同一次流内唯一，前端用它把「调用」和「结果」配对。
   */
  | { type: "tool_call"; id: string; name?: string; argsFragment: string }
  /** 工具执行完毕 */
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  /** 整段助手消息（兜底：token 流不可用时） */
  | { type: "ai_message"; content: string; node?: string }
  /**
   * 模型返回的 token 用量（取自 usage_metadata / tokenUsage）：
   * inputTokens ≈ 当时整段对话的上下文大小；cacheReadTokens 是提示词缓存命中数。
   * 同一回合约多模型协作（Demo 4）会有多条，前端保留最后一条即可。
   */
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
    }
  /** HITL：图已暂停，等待人工审批 */
  | { type: "interrupt"; payload: ApprovalPayload }
  | { type: "error"; message: string }
  | { type: "done" };
