/**
 * ============================================================
 * mock.ts — 无 API_KEY 时的「模拟模型」
 * ============================================================
 * 为什么需要 mock？
 *   学习 Demo 的第一道门槛往往是「还没配 Key 就想先看看 Agent 长什么样」。
 *   mock 模式下不需要任何网络请求，但**事件协议与真实图完全一致**
 *   （token 流 / 工具卡片 / interrupt 审批 / 多节点协作），前端渲染路径零差别。
 *
 *   唯一被模拟的是「模型的决策」，工具结果是**真实的**：
 *   calculator 真的会算、get_weather 真的会查（本地模拟表）、
 *   send_email 批准后真的走一遍发送函数。
 *
 * 触发方式：未配置 API_KEY 时服务端自动切换；配置后自动恢复真实模型。
 */
import { calculator, getCurrentTime, getWeather, sendEmail } from "../tools.js";
import type { AgentEvent, ApprovalPayload } from "./events.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MockInput {
  message?: string;              // 完整消息（含附件内容，组装后）
  rawMessage?: string;           // 用户原始输入（场景识别用它，避免被附件内容干扰）
  decision?: "approve" | "reject"; // resume：人工审批结果
  approval?: ApprovalPayload;    // resume：被审批的载荷
  turnIndex?: number;            // 本会话第几轮（用于模拟缓存命中率递增）
  signal?: AbortSignal;
}

/**
 * 模拟 usage_metadata：没有真实网关时给前端提供合理的假数据，
 * 让「上下文容量条 + 缓存占比」在模拟模式下也能演示。
 *  - inputTokens 随轮次增长（模拟历史累积）；
 *  - 第 1 轮无缓存，之后命中率逐轮升高（模拟提示词缓存）。
 */
function fabricateUsage(message: string, turnIndex: number, outputChars: number) {
  const inputTokens = 380 + Math.round(message.length * 2.4) + Math.max(0, turnIndex) * 260;
  const cacheRatio = turnIndex <= 0 ? 0 : Math.min(0.86, 0.42 + turnIndex * 0.12);
  const cacheReadTokens = Math.round(inputTokens * cacheRatio);
  const outputTokens = 110 + Math.round(outputChars * 0.85);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
  };
}

/**
 * 模拟运行入口：新消息走 scenario，resume 走审批分支。
 * 外层包装负责在流结束后补发一条合成的 usage 事件（协议与真实图一致）。
 */
export async function* mockRun(input: MockInput): AsyncGenerator<AgentEvent> {
  let outputChars = 0;
  // 有附件时先播报一句（模拟模式无法真正分析文件内容，真实模型则会直接读到）
  const attachNames = [...(input.message ?? "").matchAll(/--- 附件 \d+: (.+?)(?:（超长已截断）)? ---/g)].map((m) => m[1]);
  if (attachNames.length && !input.signal?.aborted) {
    const note = `我已读取你附加的 ${attachNames.length} 个文件（${attachNames.join("、")}）📎\n\n模拟模式无法真正分析内容，但**启用真实模型后**附件会随消息进入上下文，Agent 可直接基于它回答；右侧的上下文容量条也会随之增长。\n\n---\n\n`;
    for (const c of note.match(/[\s\S]{1,4}/g) ?? []) {
      if (input.signal?.aborted) return;
      outputChars += c.length;
      await sleep(12);
      yield { type: "token", text: c };
    }
  }
  for await (const ev of mockScenario(input)) {
    if (ev.type === "token") outputChars += ev.text.length;
    yield ev;
  }
  if (!input.signal?.aborted) {
    yield {
      type: "usage",
      ...fabricateUsage(input.message ?? "", input.turnIndex ?? 0, outputChars),
    };
  }
}

/** 把一段文本切成小块逐个吐出，模拟打字机 */
async function* streamText(
  text: string,
  signal?: AbortSignal,
  speed = 14
): AsyncGenerator<AgentEvent> {
  const chunks = text.match(/[\s\S]{1,4}/g) ?? [];
  for (const c of chunks) {
    if (signal?.aborted) return;
    await sleep(speed);
    yield { type: "token", text: c };
  }
}

/** 模拟「模型生成工具参数」：JSON 逐段流出，前端边收边渲染 */
async function* streamToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<AgentEvent> {
  const json = JSON.stringify(args);
  yield { type: "tool_call", id, name, argsFragment: "" };
  const step = Math.max(6, Math.ceil(json.length / 8));
  for (let i = 0; i < json.length; i += step) {
    if (signal?.aborted) return;
    await sleep(60);
    yield { type: "tool_call", id, argsFragment: json.slice(i, i + step) };
  }
  await sleep(150); // 「执行中」的短暂停顿，让卡片转一下
}

/** 中断点：让流在 interrupt 事件后自然结束（与真实图行为一致） */
async function* interruptFlow(req: ApprovalPayload, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
  await sleep(120);
  if (signal?.aborted) return;
  yield { type: "interrupt", payload: req };
}

// ---------------------------------------------------------------------------
// 场景识别
// ---------------------------------------------------------------------------
type Scenario = "email" | "weather" | "time" | "math" | "poem" | "memory" | "chat";

function detectScenario(message: string): Scenario {
  if (/邮件|email/i.test(message)) return "email";
  // 创作类（写诗/作文/写文章）优先于天气：一句话里同时出现「查天气+写诗」时走多 Agent 协作
  if (/诗|词|文章|作文|写一[首篇封个]|润色/.test(message)) return "poem";
  if (/天气|气温|温度/.test(message)) return "weather";
  if (/几点|时间|日期|今天.*号/.test(message)) return "time";
  if (/计算|算一下|等于多少|\d+\s*[+\-*/]\s*\d+/.test(message)) return "math";
  if (/记住|我叫|我是/.test(message)) return "memory";
  return "chat";
}

/** 从消息里提取数学表达式（找不到就给个默认值） */
function extractExpression(message: string): string {
  const m = message.match(/[\d(][\d+\-*/().\s]*[\d)]/);
  return (m?.[0] ?? "(1+2)*3").trim();
}

/** 从消息里提取城市（找不到默认北京） */
function extractCity(message: string): string {
  const m = message.match(/(北京|上海|广州|深圳|成都)/);
  return m?.[1] ?? "北京";
}

const MOCK_ID = () => `mock-${Math.random().toString(36).slice(2, 10)}`;
/** 邮件场景用确定性 id：interrupt 结束后 resume 是新的一次流，靠它把结果配对回同一张工具卡片 */
const EMAIL_TOOL_ID = "mock-send-email";

// ---------------------------------------------------------------------------
// 模拟运行入口：新消息走 scenario，resume 走审批分支
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 模拟运行（具体场景）
// ---------------------------------------------------------------------------
async function* mockScenario(input: MockInput): AsyncGenerator<AgentEvent> {
  const { signal } = input;

  // ---- Demo 3 审批恢复 ----
  if (input.decision && input.approval) {
    yield { type: "node", name: "tools" };
    if (input.decision === "approve") {
      const content = await sendEmail.invoke(
        input.approval.args as { to: string; subject: string; body: string }
      );
      yield { type: "tool_result", id: EMAIL_TOOL_ID, content };
    } else {
      yield {
        type: "tool_result",
        id: EMAIL_TOOL_ID,
        content: "用户拒绝了本次邮件发送，不要发送。",
      };
    }
    yield { type: "node", name: "agent" };
    const reply =
      input.decision === "approve"
        ? "邮件已按你的批准发送完成 ✅\n\n人工审批（Human-in-the-loop）的价值就在这里：**高风险操作在执行前必须由人类确认**，agent 自己没有权限越过这道闸门。"
        : "好的，已按你的要求**取消发送**邮件 🚫\n\n注意：拒绝后 agent 收到「用户拒绝了本次邮件发送」的工具结果，它会顺着这个结果继续回答，而不是报错崩溃 —— 这是 HITL 设计的优雅之处。";
    yield* streamText(reply, signal);
    return;
  }

  // 场景识别用「用户原始输入」，避免附件内容里的关键词误触发场景
  const message = input.rawMessage ?? input.message ?? "";
  const scenario = detectScenario(message);

  switch (scenario) {
    // ---- 发邮件：先审批，再由 resume 继续（复刻 Demo 3 完整交互）----
    case "email": {
      yield { type: "node", name: "agent" };
      yield* streamText("这是高风险操作（发送邮件），我需要先提交人工审批，请稍候…", signal);
      const to = message.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? "boss@example.com";
      const subject = message.match(/主题[是为「:：]?\s*([^，。」]*)/)?.[1]?.trim() ?? "项目进度";
      const req: ApprovalPayload = {
        type: "approval",
        toolName: "send_email",
        description: `向 ${to} 发送邮件，主题「${subject}」`,
        args: { to, subject, body: "本周项目进展顺利，关键里程碑均已按期完成。（模拟邮件正文）" },
      };
      yield { type: "node", name: "tools" };
      yield* streamToolCall(EMAIL_TOOL_ID, "send_email", req.args, signal);
      yield* interruptFlow(req, signal);
      return;
    }

    // ---- 天气（可叠加计算）：复刻 Demo 1 的 ReAct 工具循环 ----
    case "weather": {
      yield { type: "node", name: "agent" };
      yield* streamText(`好的，我先查一下天气，再帮你处理后续请求…`, signal);
      yield { type: "node", name: "tools" };
      const city = extractCity(message);
      const wId = MOCK_ID();
      yield* streamToolCall(wId, "get_weather", { city }, signal);
      yield { type: "tool_result", id: wId, content: await getWeather.invoke({ city }) };

      const expr = extractExpression(message);
      if (/\d+\s*[+\-*/]/.test(expr) && /计算|算|等于/.test(message)) {
        yield { type: "node", name: "agent" };
        yield* streamText("天气拿到了，接下来算一下你给的表达式…", signal);
        yield { type: "node", name: "tools" };
        const cId = MOCK_ID();
        yield* streamToolCall(cId, "calculator", { expression: expr }, signal);
        yield { type: "tool_result", id: cId, content: await calculator.invoke({ expression: expr }) };
      }

      yield { type: "node", name: "agent" };
      yield* streamText(
        `查询完成，汇总如下：\n\n### 结果\n\n| 项目 | 结果 |\n|------|------|\n| 天气 | ${city} 当前天气已查到 |\n| 计算 | \`${expr}\` 已计算 |\n\n> 这是**模拟模式**下的回答：模型决策是脚本编排的，但工具调用与结果是真实执行的。\n> 配置 \`API_KEY\` 后重启，即可体验真实的 LangGraph ReAct 循环。`,
        signal
      );
      return;
    }

    // ---- 时间 ----
    case "time": {
      yield { type: "node", name: "agent" };
      yield* streamText("这个问题需要调用时间工具…", signal);
      yield { type: "node", name: "tools" };
      const id = MOCK_ID();
      yield* streamToolCall(id, "get_current_time", {}, signal);
      yield { type: "tool_result", id, content: await getCurrentTime.invoke({}) };
      yield { type: "node", name: "agent" };
      yield* streamText("已经帮你查到当前时间，见上方工具结果 ⏰", signal);
      return;
    }

    // ---- 纯计算 ----
    case "math": {
      yield { type: "node", name: "agent" };
      yield* streamText("我来用计算器工具算一下…", signal);
      yield { type: "node", name: "tools" };
      const expr = extractExpression(message);
      const id = MOCK_ID();
      yield* streamToolCall(id, "calculator", { expression: expr }, signal);
      yield { type: "tool_result", id, content: await calculator.invoke({ expression: expr }) };
      yield { type: "node", name: "agent" };
      yield* streamText(`计算完成！表达式 \`${expr}\` 的结果见上方工具卡片。\n\n这个流程就是最典型的 **ReAct 循环**：思考 → 调用工具 → 观察结果 → 组织回答。`, signal);
      return;
    }

    // ---- 多 Agent 协作：复刻 Demo 4 的 supervisor → researcher → writer ----
    case "poem": {
      yield { type: "node", name: "supervisor" };
      yield* streamText("收到任务。我先分派研究员查天气，再让作家来创作。", signal);
      yield { type: "node", name: "researcher/agent" };
      yield* streamText("（研究员）我来查询北京天气…", signal);
      yield { type: "node", name: "researcher/tools" };
      const id = MOCK_ID();
      yield* streamToolCall(id, "get_weather", { city: extractCity(message) }, signal);
      const weather = await getWeather.invoke({ city: extractCity(message) });
      yield { type: "tool_result", id, content: weather };
      yield { type: "node", name: "supervisor" };
      yield* streamText("信息已齐备，交给我们组的作家来完成创作。", signal);
      yield { type: "node", name: "writer" };
      yield* streamText(
        "（作家）根据研究员提供的天气信息，成品如下：\n\n> **京华晴雨**\n> 云开日色半城秋，\n> 一纸晴光入画楼。\n> 莫问风来何处去，\n> 人间四季总相酬。\n\n主管分派 → 员工执行 → 回到主管决策，这就是 **Supervisor 多 Agent 模式**。",
        signal,
        10
      );
      return;
    }

    // ---- 记忆：复刻 Demo 2 的 checkpointer 效果 ----
    case "memory": {
      yield { type: "node", name: "agent" };
      yield* streamText(
        "好的，我记住了！在**真实模式**下，这条信息会通过 `checkpointer` 写入当前 `thread_id` 的检查点 —— 同一会话里再问「我叫什么」，我依然答得上来。\n\n> 模拟模式下没有真实记忆，重启会话即清空；接入 API Key 后可完整体验。",
        signal
      );
      return;
    }

    // ---- 兜底：自我介绍 + Markdown 能力展示 ----
    default: {
      yield { type: "node", name: "agent" };
      yield* streamText(
        `你好！我是 LangGraph Agent 学习 Demo 的**模拟模式**助手（未检测到 \`API_KEY\`）。\n\n试试这些内置场景，对应 4 个学习 Demo：\n\n1. **ReAct 工具循环** —— 「北京天气怎么样？顺便算一下 (12+7)*3」\n2. **对话记忆** —— 「我叫小明，请记住我」\n3. **人工审批** —— 「给 boss@example.com 发一封邮件，主题是项目进度」\n4. **多 Agent 协作** —— 「帮我查北京天气，然后写一首关于它的四行诗」\n\n\`\`\`ts\n// 配置真实模型只需三步：\n// cp .env.example .env   → 填入 BASE_URL / API_KEY / MODEL\n// npm run web            → 重启后自动离开模拟模式\n\`\`\``,
        signal,
        8
      );
      return;
    }
  }
}
