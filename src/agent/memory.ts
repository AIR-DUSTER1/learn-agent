/**
 * ============================================================
 * Demo 2：对话记忆（Checkpointer 检查点）
 * ============================================================
 * 本 demo 讲解的核心概念：
 *   1. Checkpointer —— 每次执行结束后把「图的状态」保存到检查点
 *   2. thread_id     —— 一条对话线程的编号；同一个 thread_id 的多轮调用共享记忆
 *   3. 无记忆 vs 有记忆：没有 checkpointer 时图每次从零开始，LLM 是「无状态的」
 *
 * 和 Demo 1 的图结构完全一样，唯一区别是 compile({ checkpointer })。
 * 你可以在 CLI 里连续提问：
 *   第一轮：「我叫小明，记住我」
 *   第二轮：「我叫什么名字？」  —— 若还记得，说明 checkpointer 生效了
 *
 * 运行：npm run demo:2
 */
import { StateGraph, START, END, MessagesAnnotation, MemorySaver } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather } from "../tools.js";

const tools = [calculator, getCurrentTime, getWeather];
const model = createChatModel().bindTools(tools);

async function agentNode(state: typeof MessagesAnnotation.State) {
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

export function createMemoryGraph() {
  // MemorySaver：内存版检查点，进程退出即丢失，适合学习
  // 生产环境可换 SqliteSaver / PostgresSaver 实现持久化
  const checkpointer = new MemorySaver();

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent")
    // ★ 关键差异：compile 时传入 checkpointer，图就拥有了记忆能力
    .compile({ checkpointer });

  return graph;
}
