/**
 * ============================================================
 * Demo 1：基础 ReAct Agent（亲手搭图，不借助 prebuilt）
 * ============================================================
 * 本 demo 讲解的核心概念：
 *   1. State（状态）      —— 图在节点间传递的数据，这里就是消息列表
 *   2. Node（节点）       —— 一个处理步骤，比如「让模型思考」或「执行工具」
 *   3. Edge（边）         —— 节点之间的连线，决定执行顺序
 *   4. Conditional Edge  —— 根据条件动态选择下一步（模型要调工具？还是直接回答？）
 *   5. ToolNode           —— 官方预置的「执行工具」节点
 *
 * 流程图（ReAct 循环）：
 *   START → agent(模型思考) → 有工具调用? ─是→ tools(执行工具) → 回到 agent
 *                            └──否──→ END(直接回答)
 *
 * 运行：npm run demo:1
 */
import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import type { AIMessage } from "@langchain/core/messages";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather } from "../tools.js";

// ---------------------------------------------------------------------------
// 1. 准备模型：把工具「绑定」到模型上，模型才知道可以调用这些函数
// ---------------------------------------------------------------------------
const tools = [calculator, getCurrentTime, getWeather];
const model = createChatModel().bindTools(tools);

// ---------------------------------------------------------------------------
// 2. 节点 1「agent」：把整段对话历史交给模型，让模型决定「直接回答」还是「调用工具」
//    返回值 { messages: [response] } 会按 State 的 reducer 追加到消息列表
// ---------------------------------------------------------------------------
async function agentNode(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

// ---------------------------------------------------------------------------
// 3. 搭图：把节点和边组织成一张有向图，compile() 之后才能调用
// ---------------------------------------------------------------------------
export function createBasicGraph() {
  const graph = new StateGraph(MessagesAnnotation)
    // -- 注册节点 --
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools))
    // -- 静态边：无条件直达 --
    .addEdge(START, "agent")
    .addEdge("tools", "agent") // 执行完工具必须回到 agent 继续思考
    // -- 条件边：根据最新一条消息判断走向 --
    // toolsCondition 是官方预置的路由函数：
    //   最新消息包含 tool_calls → 返回 "tools"（去执行工具）
    //   否则                 → 返回 END（直接输出最终回答）
    .addConditionalEdges("agent", toolsCondition)
    .compile();

  return graph;
}

// 便于 CLI 展示当前这条「消息流」中模型发出的工具调用（供日志使用）
export function getLastToolCalls(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as AIMessage | undefined;
  return last?.tool_calls ?? [];
}
