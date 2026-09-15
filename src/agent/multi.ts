/**
 * ============================================================
 * Demo 4：Supervisor 多 Agent 协作（主管 + 员工）
 * ============================================================
 * 本 demo 讲解的核心概念：
 *   1. 子图（Subgraph）—— 每个员工 agent 自己就是一张完整的图，
 *      在「包装节点」里被程序化调用（graph.invoke），结果写回主管图
 *   2. Supervisor 路由 —— 主管用「虚拟工具 delegate」做决策：
 *      模型发出 delegate(researcher/writer) 工具调用 → 条件边据此路由
 *   3. 团队协作模式 —— 员工的汇报以 ToolMessage（delegate 调用的
 *      「执行结果」）写回共享消息历史，主管接着决策，直到任务完成、
 *      主管直接回答（不再调用 delegate）→ END
 *
 * 结构：
 *   START → supervisor ─delegate(researcher)→ researcher 包装节点(内含子图: 查资料/计算)
 *                    └─delegate(writer)────→ writer 包装节点(内含子图: 写作)
 *                    └─无调用───────────────→ END
 *   两个员工执行完都会回到 supervisor
 *
 * ⚠ 为什么员工汇报要包装成 ToolMessage，而不是把子图消息直接并回状态：
 *   思考型模型（如 deepseek-flash）要求「请求里最后一条 assistant 消息
 *   必须携带 reasoning_content」，而 @langchain/openai 序列化请求时会丢弃
 *   reasoning_content —— 若把子图的 AI 消息原样并回，主管的下一轮调用
 *   （最后一条正好是 assistant）会被网关 400。ToolMessage 形式同时满足
 *   OpenAI 协议「每个 tool_call 必须有对应 tool 消息」的强校验，也是
 *   supervisor 模式的标准形态。
 *
 * 运行：npm run demo:4
 * 试试输入：「帮我查一下北京天气，然后写一首关于它的四行诗」
 */
import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode, toolsCondition } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { createChatModel } from "../llm.js";
import { calculator, getCurrentTime, getWeather } from "../tools.js";

// ---------------------------------------------------------------------------
// 团队成员名单（写死在提示词和路由里，方便理解）
// ---------------------------------------------------------------------------
const MEMBERS = ["researcher", "writer"] as const;

// ===========================================================================
// 主管的「虚拟工具」delegate：永远不会真正执行，只用来做分派决策（路由）
// ===========================================================================
const delegateTool = tool(
  async () => "该工具仅用于路由决策，不会真正执行。",
  {
    name: "delegate",
    description:
      "把子任务分派给团队成员。researcher 负责查资料/计算/天气等事实收集；writer 负责写作和润色。",
    schema: z.object({
      task: z.string().describe("要交给成员完成的具体任务描述"),
      member: z.enum(MEMBERS).describe("接收任务的成员"),
    }),
  }
);

// ===========================================================================
// 员工 1：研究员子图 —— 自己带工具的 ReAct agent（和 Demo 1 结构相同）
// ===========================================================================
const researchTools = [calculator, getCurrentTime, getWeather];

/** 条件边：根据主管最新一条消息中的 delegate 调用，决定路由到哪个员工 */
function routeFromSupervisor(state: typeof MessagesAnnotation.State) {
  const last = state.messages.at(-1) as AIMessage | undefined;
  const call = last?.tool_calls?.[0];
  if (call?.name === "delegate") {
    const member = call.args.member as string;
    return MEMBERS.includes(member as (typeof MEMBERS)[number]) ? member : "researcher";
  }
  return END; // 主管不再分派 → 全图结束
}

export function createMultiAgentGraph() {
  // ★ 模型在建图时创建：Web 端修改供应商/模型后，新建会话即用新配置
  const researcherModel = createChatModel().bindTools(researchTools);
  const writerModel = createChatModel();
  const supervisorModel = createChatModel().bindTools([delegateTool]);

  async function researcherAgentNode(state: typeof MessagesAnnotation.State) {
    const response = await researcherModel.invoke([
      {
        role: "system",
        content:
          "你是团队里的研究员，负责查资料、计算和收集信息。你只负责事实收集，不要写作、润色或创作，创作任务会由作家同事完成。完成任务后用中文简明扼要地汇报结论。",
      },
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  const researcherGraph = new StateGraph(MessagesAnnotation)
    .addNode("agent", researcherAgentNode)
    .addNode("tools", new ToolNode(researchTools))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", toolsCondition)
    .addEdge("tools", "agent")
    .compile();

  // =========================================================================
  // 员工 2：作家子图 —— 没有工具，专注写作/润色
  // =========================================================================
  async function writerAgentNode(state: typeof MessagesAnnotation.State) {
    const response = await writerModel.invoke([
      {
        role: "system",
        content:
          "你是团队里的作家，擅长写作、润色和表达。请根据研究员提供的信息完成写作任务，直接输出成品。",
      },
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  const writerGraph = new StateGraph(MessagesAnnotation)
    .addNode("agent", writerAgentNode)
    .addEdge(START, "agent")
    .compile();

  // =========================================================================
  // 员工包装节点：先给 delegate 调用补一条内部回执（子图内可见），
  // 程序化运行子图，再把成员的最终汇报包装成 delegate 的 ToolMessage 返回。
  // （子图只在此处调用、不直接注册为节点 → 子图内部消息不流入主管历史，
  //   详见文件头「为什么包装成 ToolMessage」）
  // =========================================================================
  // 只依赖用到的最小接口，绕开 CompiledStateGraph 的复杂泛型
  function makeMemberNode(
    label: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subgraph: { invoke(input: any, config?: unknown): Promise<{ messages: Array<{ content: unknown }> }> }
  ) {
    return async (state: typeof MessagesAnnotation.State, config: LangGraphRunnableConfig) => {
      const last = state.messages.at(-1) as AIMessage | undefined;
      const call = last?.tool_calls?.find((c) => c.name === "delegate");
      if (!call) return { messages: [] };

      const inner = await subgraph.invoke(
        {
          messages: [
            ...state.messages,
            // 给子图内的模型补 delegate 回执：子图第一个模型调用的
            // 上一条消息不能是没有 tool 结果的 tool_calls（网关强校验）
            new ToolMessage({ tool_call_id: call.id!, content: `任务已分派给${label}，请执行并汇报。` }),
          ],
        },
        config
      );
      const report = inner.messages.at(-1);
      return {
        messages: [
          new ToolMessage({
            tool_call_id: call.id!,
            content: `【${label}汇报】${String(report?.content ?? "（无输出）")}`,
          }),
        ],
      };
    };
  }

  // =========================================================================
  // 主管节点：用「虚拟工具」做分派决策（工具永远不会真正执行，只用来路由）
  // =========================================================================
  async function supervisorNode(state: typeof MessagesAnnotation.State) {
    const response = await supervisorModel.invoke([
      {
        role: "system",
        content: [
          "你是团队主管。请按需把任务分派给成员：",
          "- 需要查资料 / 计算 / 天气等事实信息 → delegate 给 researcher",
          "- 需要写作 / 润色 / 创作 → delegate 给 writer",
          "- 若所有信息已齐备、任务已完成 → 直接给出最终答复，不要再调用 delegate",
        ].join("\n"),
      },
      ...state.messages,
    ]);
    return { messages: [response] };
  }

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("supervisor", supervisorNode)
    .addNode("researcher", makeMemberNode("研究员", researcherGraph))
    .addNode("writer", makeMemberNode("作家", writerGraph))
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeFromSupervisor)
    // 无论哪个员工执行完，都要回到主管继续决策
    .addEdge("researcher", "supervisor")
    .addEdge("writer", "supervisor")
    .compile();

  return graph;
}
