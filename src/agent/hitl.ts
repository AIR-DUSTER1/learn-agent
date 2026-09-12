/**
 * ============================================================
 * Demo 3：Human-in-the-loop（人工介入工作流）
 * ============================================================
 * 本 demo 讲解的核心概念：
 *   1. interrupt() —— 在节点内部暂停图的执行，把「决策权」交给人类
 *   2. resume      —— 用 Command({ resume: 值 }) 把人类的决定送回图里继续跑
 *   3. 适用场景    —— 高风险操作（发邮件、付款、删数据）执行前必须人工确认
 *
 * 交互流程：
 *   agent 决定调用 send_email → tools 节点发现是高风险操作
 *     → interrupt() 暂停 → CLI 弹出审批框（y/n）
 *     → 用户批准 → 执行 send_email；用户拒绝 → 生成拒绝结果的 ToolMessage
 *     → 回到 agent 继续总结输出
 *
 * 运行：npm run demo:3
 */
import {
  StateGraph,
  START,
  END,
  MessagesAnnotation,
  MemorySaver,
  interrupt,
  Command,
} from "@langchain/langgraph";
import { toolsCondition } from "@langchain/langgraph/prebuilt";
import type { AIMessage, ToolMessage } from "@langchain/core/messages";
import { ToolMessage as ToolMessageCls } from "@langchain/core/messages";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather, sendEmail, toolsByName } from "../tools.js";
import type { Tool } from "@langchain/core/tools";

// ---------------------------------------------------------------------------
// 工具集：多了一个「高风险」的 send_email
// ---------------------------------------------------------------------------
const tools = [calculator, getCurrentTime, getWeather, sendEmail];

/** 传给 interrupt() 的载荷：CLI 根据它渲染审批提示 */
export interface ApprovalRequest {
  type: "approval";
  toolName: string;
  description: string;
  args: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 节点「tools」：手动实现工具执行循环（演示 ToolNode 的内部原理）
//   ★ 关键：执行 send_email 之前先 interrupt() 暂停，等人类点头
//   （本节点不依赖模型，放在模块级；模型在建图时才创建）
//   导出复用：通用 Agent（general.ts）也用这个节点做高风险操作审批
// ---------------------------------------------------------------------------
export async function approvalToolsNode(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages.at(-1) as AIMessage;
  const toolResults: ToolMessage[] = [];

  for (const call of lastMessage.tool_calls ?? []) {
    if (call.name === "send_email") {
      // ---- 高风险操作：暂停图，向人类请求审批 ----
      // interrupt() 的参数会原样出现在流输出里（__interrupt__），
      // 返回值则是 CLI 通过 Command({ resume }) 传回来的内容
      // interrupt<I, R>：I 是传给人类的「暂停载荷」（会出现在 __interrupt__ 流里），
      // R 是 resume 时 Command({ resume }) 传回来的值类型
      const decision = interrupt<ApprovalRequest, "approve" | "reject">({
        type: "approval",
        toolName: call.name,
        description: `向 ${String(call.args.to)} 发送邮件，主题「${String(call.args.subject)}」`,
        args: call.args as Record<string, unknown>,
      });

      // ---- 根据人类的决定继续执行 ----
      const content =
        decision === "approve"
          ? await sendEmail.invoke(
              call.args as { to: string; subject: string; body: string }
            ) // 批准 → 真正执行
          : "用户拒绝了本次邮件发送，不要发送。"; // 拒绝 → 生成结果消息

      toolResults.push(
        new ToolMessageCls({ content, tool_call_id: call.id ?? "" })
      );
    } else {
      // 普通工具：直接执行，无需审批
      // toolsByName 的值是多个工具组成的联合类型，invoke 参数签名互不兼容，
      // 基类 Tool 的 schema 类型与 DynamicStructuredTool 也不重叠，只能经 unknown 收窄。
      // （运行时 call.args 就是模型为该工具填的参数，与工具 schema 一致）
      const toolFn = toolsByName[call.name] as unknown as Tool;
      const content = await toolFn.invoke(call.args);
      toolResults.push(new ToolMessageCls({ content, tool_call_id: call.id ?? "" }));
    }
  }

  // 把工具结果追加进消息历史，agent 下一轮才能「看到结果并总结」
  return { messages: toolResults };
}

export function createHitlGraph() {
  // ★ 模型在建图时创建：Web 端修改供应商/模型后，新建会话即用新配置
  const model = createChatModel().bindTools(tools);

  // 节点「agent」：与 Demo 1 相同，让模型决定回答还是调工具
  async function agentNode(state: typeof MessagesAnnotation.State) {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  }

  // interrupt/resume 依赖 checkpointer 保存「暂停时的状态」，所以必须有
  const checkpointer = new MemorySaver();

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", approvalToolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent")
    .compile({ checkpointer });

  return graph;
}

/** 供 CLI / Web 使用：把用户的审批结果「喂」回被暂停的图 */
export function buildResumeCommand(decision: "approve" | "reject") {
  // Command 的泛型参数：Resume 值类型 / Update / 目标节点。
  // 纯 resume 命令不涉及 goto 路由，这里显式给三个 any 省略类型推断。
  return new Command<any, any, any>({ resume: decision });
}
