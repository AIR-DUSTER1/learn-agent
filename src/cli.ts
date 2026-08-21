/**
 * ============================================================
 * cli.ts — 4 个 LangGraph Demo 的统一入口（互动式 CLI）
 * ============================================================
 * 运行方式：
 *   npm run demo:1   基础 ReAct Agent（单轮，可带自定义问题）
 *   npm run demo:2   对话记忆（多轮 REPL，演示 checkpointer + thread_id）
 *   npm run demo:3   Human-in-the-loop（多轮 REPL，发邮件需人工审批）
 *   npm run demo:4   多 Agent 协作（单轮，可带自定义任务）
 *   npm run start    （不带参数）弹出选择菜单
 *
 * 传自定义问题的写法：npx tsx src/cli.ts 1 "帮我算一下 2^8"
 *
 * 每个 Demo 的详细讲解注释都在 src/agent/ 对应文件里，
 * 这里只负责「让流程可视化」：用 streamMode: "updates" 逐节点打印，
 * 你能亲眼看到 agent 思考 → 调工具 → 看到结果 → 继续思考的循环。
 */
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import { assertConfig } from "./config.js";
import { createBasicGraph } from "./agent/basic.js";
import { createMemoryGraph } from "./agent/memory.js";
import { createHitlGraph, buildResumeCommand } from "./agent/hitl.js";
import type { ApprovalRequest } from "./agent/hitl.js";
import { createMultiAgentGraph } from "./agent/multi.js";

type Rl = ReturnType<typeof createInterface>;

// ---------------------------------------------------------------------------
// 小工具：把消息内容转成纯文本（兼容字符串 / 内容块数组两种格式）
// ---------------------------------------------------------------------------
function fmtContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (typeof part === "string" ? part : "text" in part ? part.text : ""))
    .join("");
}

/**
 * 统一的「逐行读取器」。
 *
 * 为什么不用 rl.question() 循环？
 *   实测发现：管道输入（echo ... | npm run demo:2）时，readline 读完第一行
 *   就会触发 close，后面的行再也读不到。用 line/close 事件 + 等待队列则两种
 *   场景都稳定：EOF（或 Ctrl+D）时 next() 返回 null，循环自然结束。
 *
 * 另一个好处：Demo 3 的「审批 y/n」也走同一个队列，规避了 readline 同一时刻
 * 只允许一个 question() 的限制（图在 stream 时不能嵌套调用 question）。
 */
class LineReader {
  private queue: Array<string | null> = [];
  private waiters: Array<(line: string | null) => void> = [];

  constructor(rl: Rl) {
    rl.on("line", (line) => this.push(line));
    rl.on("close", () => this.push(null)); // EOF 时唤醒等待者
  }

  private push(line: string | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.queue.push(line);
  }

  /** 读下一行；输入流结束时返回 null */
  next(): Promise<string | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

const isQuit = (line: string) => /^(exit|quit|q|退出|结束)$/i.test(line.trim());

/**
 * 打印一条消息更新。streamMode:"updates" 下事件形如 { 节点名: { messages: [...] } }。
 * 子图（Demo 4）的事件键可能是 "researcher:agent" 这种嵌套/带冒号的形状，
 * 所以这里做递归展开，保证任何深度都能打印出来。
 */
// 子图会把「进入子图前已经存在于 state 里的消息」在更新里再回显一遍，
// 这些消息与之前打印过的是同一个对象（id 相同），记录已打印 id 即可去重。
// 再配合「消息计数游标」：子图回显的是完整历史，只打印游标之后的新消息。
const printedMessageIds = new Set<string>();
let seenMessageCount = 0;

/** 把某个节点更新里「真正新增」的消息收集成日志行（不直接打印，便于外层判断有没有内容） */
function collectUpdateLines(
  key: string,
  update: Record<string, unknown>,
  out: string[]
): void {
  const messages = update.messages as unknown;
  if (Array.isArray(messages)) {
    // 只用 index 从 seenMessageCount 起打印 → 跳过子图回显的整段历史
    for (let i = seenMessageCount; i < messages.length; i++) {
      const msg = messages[i] as AIMessage | ToolMessage;
      // 跳过 HumanMessage：节点输出的更新里出现它，通常是子图把输入消息回显了一遍，
      // 用户输入在 CLI 里已经打印过，这里只展示 AI/工具消息，避免重复
      if (msg instanceof HumanMessage) continue;
      if (msg.id && printedMessageIds.has(msg.id)) continue; // 回显 → 已打印过
      if (msg.id) printedMessageIds.add(msg.id);
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        const calls = msg.tool_calls
          .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
          .join(", ");
        out.push(`   🔧 [${key}] 模型请求调用工具: ${calls}`);
      } else if (msg instanceof ToolMessage && msg.content) {
        out.push(`   📦 [${key}] 工具返回: ${fmtContent(msg.content).slice(0, 140)}`);
      } else if (msg.content) {
        const icon = msg instanceof AIMessage ? "🤖" : "👤";
        out.push(`   ${icon} [${key}] ${fmtContent(msg.content).slice(0, 400)}`);
      }
    }
    // 推进游标（子图回显的历史可能比游标长，取 max 避免回退）
    seenMessageCount = Math.max(seenMessageCount, messages.length);
    return;
  }
  // 嵌套结构（子图）：继续往下展开
  for (const [childKey, child] of Object.entries(update)) {
    if (child && typeof child === "object") {
      collectUpdateLines(`${key}:${childKey}`, child as Record<string, unknown>, out);
    }
  }
}

/**
 * 以「逐节点更新」模式跑一张图并实时打印。
 * 若遇到 interrupt() 暂停（Demo 3），停止打印并返回暂停信息给调用方处理。
 */
async function streamGraph(
  // Demo 1~4 的图节点名各不相同，CompiledStateGraph 的节点泛型是逆变位置，
  // 用 any 收窄会互相冲突；这里只需要 .stream() 方法，直接按鸭子类型用 any
  graph: any,
  input: Record<string, unknown>,
  threadId: string
): Promise<{ value: ApprovalRequest } | null> {
  // 注意：LangGraph v1 的 stream(input, options) 只有两个参数，
  // streamMode 和 configurable 都合并到 options 里传
  const stream = await graph.stream(input, {
    streamMode: "updates",
    configurable: { thread_id: threadId },
  });
  // 每轮对话独立重置打印游标（子图回显去重用）
  printedMessageIds.clear();
  seenMessageCount = 0;
  for await (const event of stream) {
    if ("__interrupt__" in event) {
      return (event as { __interrupt__: Array<{ value: ApprovalRequest }> }).__interrupt__[0];
    }
    for (const [node, update] of Object.entries(event)) {
      const lines: string[] = [];
      collectUpdateLines(node, update as Record<string, unknown>, lines);
      if (lines.length) {
        console.log(`\n── 节点执行: ${node} ──`);
        for (const line of lines) console.log(line);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Demo 1：基础 ReAct Agent —— 亲手搭图，看工具调用循环
// ---------------------------------------------------------------------------
async function demo1(question: string): Promise<void> {
  console.log(`
============================================================
 Demo 1：基础 ReAct Agent（搭图入门）
 概念：State 状态 · Node 节点 · Edge 边 · Conditional Edge 条件边
 流程：START → agent(思考) → 要调工具? ─是→ tools(执行) → 回 agent
                           └──否──→ END(直接回答)
 详细注释：src/agent/basic.ts
============================================================`);
  const graph = createBasicGraph();
  console.log(`\n🧪 输入: ${question}\n`);
  await streamGraph(graph, { messages: [new HumanMessage(question)] }, "demo1");
  console.log("\n✅ Demo 1 完成（未配 checkpointer → 图不保留任何记忆）");
}

// ---------------------------------------------------------------------------
// Demo 2：对话记忆 —— 同一 thread_id 的多轮对话共享记忆
// ---------------------------------------------------------------------------
async function demo2(rl: Rl): Promise<void> {
  console.log(`
============================================================
 Demo 2：对话记忆（Checkpointer 检查点）
 概念：compile({ checkpointer }) 保存每次执行后的状态；
       thread_id 是「会话线程序号」，同一个 thread_id 共享记忆。
 试试：先输入「我叫小明」，再问「我叫什么名字？」
 详细注释：src/agent/memory.ts
============================================================`);
  const graph = createMemoryGraph();
  const threadId = "demo2-thread-1";
  const reader = new LineReader(rl);
  console.log("\n（输入 exit / quit / q 退出）");

  while (true) {
    const line = await reader.next();
    if (line === null || isQuit(line)) break;
    console.log("");
    await streamGraph(graph, { messages: [new HumanMessage(line)] }, threadId);
  }
  console.log("\n✅ Demo 2 结束（进程退出后 MemorySaver 中的记忆即丢失）");
}

// ---------------------------------------------------------------------------
// Demo 3：Human-in-the-loop —— 高风险操作（发邮件）执行前人工审批
// ---------------------------------------------------------------------------
async function demo3(rl: Rl): Promise<void> {
  console.log(`
============================================================
 Demo 3：Human-in-the-loop（人工介入工作流）
 概念：interrupt() 在节点内部暂停图，把决策权交给人类；
       Command({ resume }) 把人类决定送回图继续执行。
 试试：输入「给 boss@example.com 发一封邮件，主题是项目进度」
 详细注释：src/agent/hitl.ts
============================================================`);
  const graph = createHitlGraph();
  const threadId = "demo3-thread-1";
  const reader = new LineReader(rl);
  console.log("\n（输入 exit / quit / q 退出）");

  while (true) {
    const line = await reader.next();
    if (line === null || isQuit(line)) break;
    console.log("");

    const interrupted = await streamGraph(graph, { messages: [new HumanMessage(line)] }, threadId);
    if (interrupted) {
      const req = interrupted.value;
      console.log(`\n⏸️  图已暂停，等待人工审批（输入 y / 是 批准，n / 否 拒绝）：
  工具: ${req.toolName}
  请求: ${req.description}`);
      const ans = await reader.next();
      if (ans === null || isQuit(ans)) break;
      // 中文也支持：y / yes / 是 / 对 / 同意 → 批准，其余 → 拒绝
      const decision = /^(y|yes|是|对|同意|批准)$/i.test(ans.trim()) ? "approve" : "reject";
      console.log(`  👤 你的决定: ${decision === "approve" ? "✅ 批准，继续执行" : "🚫 拒绝，不执行"}\n`);

      // resume：用 Command 把决定送回被暂停的图，一次性跑完剩余流程
      const result = await graph.invoke(buildResumeCommand(decision), {
        configurable: { thread_id: threadId },
      });
      const last = result.messages.at(-1) as AIMessage | undefined;
      if (last?.content) {
        console.log(`   🤖 最终回答: ${fmtContent(last.content)}`);
      }
    }
  }
  console.log("\n✅ Demo 3 结束");
}

// ---------------------------------------------------------------------------
// Demo 4：Supervisor 多 Agent 协作 —— 主管分派任务给员工子图
// ---------------------------------------------------------------------------
async function demo4(task: string): Promise<void> {
  console.log(`
============================================================
 Demo 4：多 Agent 协作（Supervisor 主管 + 员工子图）
 概念：每个员工是一张独立子图，可当「节点」嵌进主管图；
       主管用虚拟工具 delegate 做路由决策。
 流程：supervisor ─delegate(researcher)→ 查资料/计算
                ─delegate(writer)────→ 写作/润色
                ─无调用──────────────→ END
 详细注释：src/agent/multi.ts
============================================================`);
  const graph = createMultiAgentGraph();
  console.log(`\n🧪 任务: ${task}\n`);
  await streamGraph(graph, { messages: [new HumanMessage(task)] }, "demo4");
  console.log("\n✅ Demo 4 完成");
}

// ---------------------------------------------------------------------------
// 入口：菜单 / 直接运行 / 退出处理
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  assertConfig();

  const arg = process.argv[2];
  const rl = createInterface({ input, output });

  if (!arg) {
    // 无参数：弹出选择菜单
    console.log(`
============================================
   LangGraph.js Agent 学习 Demo 启动器
============================================
   1. 基础 ReAct Agent —— 搭图 / 节点 / 边 / 工具循环
   2. 对话记忆 —— Checkpointer + thread_id 多轮记忆
   3. Human-in-the-loop —— interrupt() 暂停 + 人工审批
   4. 多 Agent 协作 —— Supervisor 主管 + 员工子图
--------------------------------------------`);
    try {
      const ans = await rl.question("请选择 Demo 编号 (1-4) > ");
      await runDemo(Number(ans), rl);
    } catch {
      // 管道输入时 question() 可能因 EOF 直接失败，给出用法提示
      console.error("未读取到选择。用法：npm run demo:1 ~ demo:4");
      process.exitCode = 1;
    }
  } else {
    await runDemo(Number(arg), rl);
  }
  rl.close();
}

async function runDemo(n: number, rl: Rl): Promise<void> {
  // 允许通过第三个参数传自定义问题/任务，例如：tsx src/cli.ts 1 "帮我算 (5+3)*2"
  const userArg = process.argv[3];
  switch (n) {
    case 1:
      await demo1(userArg ?? "北京现在天气怎么样？顺便帮我算一下 (12+7)*3 等于多少？");
      break;
    case 2:
      await demo2(rl);
      break;
    case 3:
      await demo3(rl);
      break;
    case 4:
      await demo4(userArg ?? "帮我查一下北京的天气，然后写一首关于它的四行诗");
      break;
    default:
      console.error(`未知 Demo 编号: ${n}（支持 1-4）`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n❌ 运行出错:", err instanceof Error ? err.message : err);
  if (process.env.DEBUG === "1" && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
