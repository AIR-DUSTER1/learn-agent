/**
 * ============================================================
 * Demo 5：并行 map-reduce（Send API 动态分发）
 * ============================================================
 * 本 demo 讲解的核心概念（前 4 个 demo 都没覆盖到）：
 *   1. 自定义 State      —— 不再用 MessagesAnnotation，而是用 Annotation.Root
 *                          定义自己的字段和「合并规则 reducer」
 *   2. Reducer（合并器） —— 多个并行节点同时写同一个字段时，靠 reducer 合并。
 *                          results 用 concat 追加 → 天然实现 fan-in（汇聚）
 *   3. Send API          —— 条件边的路由函数不返回节点名，而是返回若干个
 *                          `new Send("worker", { ... })`：给 worker 节点
 *                          「私有发一份输入」，有几个主题就并行跑几个 worker
 *   4. map-reduce 模式   —— 先 fan-out（并行处理每个子任务），
 *                          再 fan-in（全部完成后进入汇总节点）
 *
 * 流程图（map-reduce）：
 *                        ┌─→ worker("人工智能")  ─┐
 *   START ─Send×N 分发─→ ├─→ worker("量子计算")  ─┼─→ 汇总 combine ─→ END
 *                        └─→ worker("航天探索")  ─┘
 *   （三个 worker 并行执行，全部完成后自动进入 combine —— 超步屏障）
 *
 * 运行：npm run demo:5
 * 试试：npx tsx src/cli.ts 5 "咖啡, 露营, 极光"   （自定义主题列表，逗号分隔）
 *
 * ⚠️ 注意：本 demo 在 CLI 里用 updates 模式（不做 token 流式打印），
 *    因为多个 worker 的 token 会交错输出，反而看不清并行结构。
 */
import { StateGraph, START, END, Annotation, Send } from "@langchain/langgraph";
import { createChatModel } from "../llm.js";

// ---------------------------------------------------------------------------
// 1. 自定义 State：这个 demo 完全不需要 messages！
//    - subjects：用户输入的主题列表（LastValue 语义，只保留最新值）
//    - results：每个 worker 的产出；reducer 用 concat 追加 ——
//      并行 worker 各自返回 { results: [一条] }，LangGraph 自动 concat 汇聚
//    - summary：combine 节点写的最终文案
// ---------------------------------------------------------------------------
const ParallelState = Annotation.Root({
  subjects: Annotation<string[]>({
    reducer: (_old, updated) => updated,
    default: () => [],
  }),
  results: Annotation<string[]>({
    reducer: (old, updated) => old.concat(updated),
    default: () => [],
  }),
  summary: Annotation<string>({
    reducer: (_old, updated) => updated,
  }),
});

const model = createChatModel(0.7); // 写文案稍微放开一点创造性

// ---------------------------------------------------------------------------
// 2. map：worker 节点 —— 注意它的输入不是整个 State！
//    Send 发来什么它就收到什么（这里是 { subject: string }），
//    所以可以在同一张图里给同一个节点发 N 份不同的私有输入
// ---------------------------------------------------------------------------
async function workerNode(input: { subject: string }) {
  const response = await model.invoke([
    {
      role: "user",
      content:
        `请为「${input.subject}」这个主题写一句 20 字以内、有创意的中文宣传语。` +
        `只输出宣传语本身，不要任何解释。`,
    },
  ]);
  const slogan = typeof response.content === "string" ? response.content.trim() : "";
  // 每个 worker 只贡献一条结果；reducer 负责把大家的贡献合并成一个数组
  return { results: [`「${input.subject}」：${slogan}`] };
}

// ---------------------------------------------------------------------------
// 3. reduce：combine 节点 —— 所有 worker 都完成后才会执行（超步屏障），
//    此时 state.results 已经是汇聚好的完整列表
// ---------------------------------------------------------------------------
async function combineNode(state: typeof ParallelState.State) {
  const response = await model.invoke([
    {
      role: "user",
      content:
        `以下是几条主题宣传语：\n${state.results.map((r) => `- ${r}`).join("\n")}\n` +
        `请把它们整合成一段 80 字以内的连贯介绍文案。只输出文案本身。`,
    },
  ]);
  const summary = typeof response.content === "string" ? response.content.trim() : "";
  return { summary };
}

// ---------------------------------------------------------------------------
// 4. 分发函数：条件边返回 Send 数组 = 动态 fan-out
//    （对比：Demo 1/4 的条件边返回的是「节点名字符串」，一次只去一个地方）
// ---------------------------------------------------------------------------
function dispatch(state: typeof ParallelState.State): Send[] {
  return state.subjects.map((subject) => new Send("worker", { subject }));
}

export function createParallelGraph() {
  const graph = new StateGraph(ParallelState)
    .addNode("worker", workerNode)
    .addNode("combine", combineNode)
    // START 的条件边返回 Send[] → 有几个主题就并行派几个 worker
    .addConditionalEdges(START, dispatch)
    // fan-in：所有 worker 写完 results 后自动进入 combine
    .addEdge("worker", "combine")
    .addEdge("combine", END)
    .compile();

  return graph;
}

/** 解析用户输入的主题列表："咖啡, 露营, 极光" → ["咖啡","露营","极光"] */
export function parseSubjects(raw: string | undefined): string[] {
  const list = (raw ?? "人工智能, 量子计算, 航天探索")
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list.slice(0, 6) : ["人工智能", "量子计算", "航天探索"]; // 上限 6 个，防止滥用
}
