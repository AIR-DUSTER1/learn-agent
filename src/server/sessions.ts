/**
 * ============================================================
 * sessions.ts — Web 会话存储（内存版）
 * ============================================================
 * 会话分两种：
 *   - kind: "agent"  通用 Agent（默认，正常产品逻辑：工具 + 审批 + 多轮记忆）
 *   - kind: "demo"   内置示例（学习 Demo 1-4，图结构刻意保持教学形态）
 *
 * 每个会话一张图实例：
 *   - 通用 Agent / Demo 2 / Demo 3：编译时持有 MemorySaver，
 *     thread_id 绑定 session id → 多轮记忆与审批状态延续；
 *   - Demo 1 / Demo 4：教学上故意不带 checkpointer（展示无记忆的行为差异），本身无状态。
 *
 * 这是学习项目，故与 MemorySaver 一样选择「进程内存」方案：
 * 服务重启后会话即消失（前端会标注历史会话为「已失效」）。
 * 生产环境可换 SqliteSaver / PostgresSaver 并把 session 落库。
 */
import { randomUUID } from "node:crypto";
import { createBasicGraph } from "../agent/basic.js";
import { createMemoryGraph } from "../agent/memory.js";
import { createHitlGraph } from "../agent/hitl.js";
import { createMultiAgentGraph } from "../agent/multi.js";
import { createAgentGraph } from "../agent/general.js";
import { getExternalAgent } from "./external.js";
import type { AgentEvent, ApprovalPayload } from "./events.js";

export interface DemoMeta {
  id: 1 | 2 | 3 | 4;
  name: string;
  desc: string;
  example: string;
}

/** 内置示例（学习 Demo）：作为新建对话时的可选预设 */
export const DEMOS: DemoMeta[] = [
  { id: 1, name: "基础 ReAct", desc: "示例 · State / Node / 边 / 工具调用循环", example: "北京现在天气怎么样？顺便帮我算一下 (12+7)*3 等于多少？" },
  { id: 2, name: "对话记忆", desc: "示例 · Checkpointer + thread_id 多轮记忆", example: "我叫小明，请记住我" },
  { id: 3, name: "人工审批", desc: "示例 · interrupt() 暂停 + 人工批准/拒绝", example: "给 boss@example.com 发一封邮件，主题是项目进度" },
  { id: 4, name: "多 Agent", desc: "示例 · Supervisor 主管 + 员工子图协作", example: "帮我查一下北京的天气，然后写一首关于它的四行诗" },
];

export function isDemo(v: unknown): v is 1 | 2 | 3 | 4 {
  return v === 1 || v === 2 || v === 3 || v === 4;
}

export type SessionKind = "agent" | "demo" | "external";

/** 一轮对话的服务端记录：用户消息 + 该轮全部 AgentEvent（供任意浏览器回放历史） */
export interface TurnRecord {
  /** 用户消息文本（审批恢复轮为「(批准/拒绝 xx)」标记） */
  user: string;
  /** 随消息附加的文件元信息（与前端 user block 的 files 对应） */
  files?: Array<{ name: string; source: string; image: boolean }>;
  /** 该轮 SSE 推给前端的全部事件（含 usage/error/interrupt，不含 done） */
  events: AgentEvent[];
}

const MAX_TURN_RECORDS = 100;   // 每会话最多保留轮数
const MAX_RECORD_EVENTS = 3000; // 单轮事件数上限（异常防护）

export interface Session {
  id: string;
  kind: SessionKind;
  demo: 1 | 2 | 3 | 4 | null;
  /** kind === "external"：接入的第三方 Agent id（external.ts 注册表） */
  agentId: string | null;
  /** 归属的项目文件夹（"default" = 内置本仓库项目） */
  projectId: string;
  title: string;
  createdAt: number;
  /** 本会话的图实例（通用 Agent / Demo 2/3 的 checkpointer 记忆存于实例内） */
  graph: unknown;
  /** thread_id 与 session 绑定，同一会话多轮共享记忆 */
  threadId: string;
  /** Demo 3：是否正处于 interrupt 等待审批 */
  pendingApproval: ApprovalPayload | null;
  /** 建图时的配置版本号 —— 配置变更后首次使用时按需重建图（见 rebuildIfStale） */
  configVersion: number;
  /** 已完成的对话轮数（供 mock 模式模拟用量递增 / 缓存命中率） */
  turns: number;
  /** 服务端对话记录（每轮用户消息 + 全部事件），任意浏览器都能回放历史 */
  turnHistory: TurnRecord[];
}

const sessions = new Map<string, Session>();

/** 全局配置版本号：每次保存设置 +1；会话图版本落后时重建以套用新模型 */
let configVersionCounter = 1;
export function bumpConfigVersion(): void {
  configVersionCounter += 1;
}
export function currentConfigVersion(): number {
  return configVersionCounter;
}

export function buildGraph(kind: SessionKind, demo: 1 | 2 | 3 | 4 | null): unknown {
  if (kind === "agent") return createAgentGraph();
  switch (demo) {
    case 1: return createBasicGraph();
    case 2: return createMemoryGraph();
    case 3: return createHitlGraph();
    case 4: return createMultiAgentGraph();
    default: return createAgentGraph();
  }
}

/**
 * 配置变更后该会话首次使用时：用当前配置重建图。
 * 注意：重建会得到新的 MemorySaver —— 通用 Agent / Demo 2/3 的多轮记忆
 * 因此重置（等价于「改配置后重启服务」，UI 会提示这一点）。
 */
export function rebuildIfStale(session: Session): boolean {
  if (session.kind === "external") return false; // 外部会话无图，不需要重建
  if (session.configVersion === configVersionCounter) return false;
  session.graph = buildGraph(session.kind, session.demo);
  session.configVersion = configVersionCounter;
  session.pendingApproval = null; // 旧图上的 interrupt 状态随重建失效
  return true;
}

export function createSession(kind: SessionKind, demo: 1 | 2 | 3 | 4 | null, projectId: string | undefined, title?: string, agentId?: string | null): Session {
  // 外部 Agent 会话不建 LangGraph：每条消息直接启动第三方工具的子进程（external.ts）
  const external = kind === "external" ? getExternalAgent(agentId ?? "") : undefined;
  if (kind === "external" && !external) throw new Error("外部 Agent 不存在或已被移除");
  const session: Session = {
    id: randomUUID(),
    kind,
    demo: kind === "demo" ? demo : null,
    agentId: external?.id ?? null,
    projectId: projectId || "default",
    title: title?.trim() || (external ? external.name : kind === "demo" ? `${DEMOS.find((d) => d.id === demo)?.name ?? "示例"} 示例` : "新对话"),
    createdAt: Date.now(),
    graph: kind === "external" ? null : buildGraph(kind, demo),
    threadId: `web-${randomUUID()}`,
    pendingApproval: null,
    configVersion: currentConfigVersion(),
    turns: 0,
    turnHistory: [],
  };
  sessions.set(session.id, session);
  return session;
}

// ---------------------------------------------------------------------------
// 服务端对话记录：开始一轮 / 流结束后回填事件 / 读取
// ---------------------------------------------------------------------------

/** 流开始前调用：登记本轮的用户消息（files 与前端 user block 的 files 同形） */
export function beginTurnRecord(
  session: Session,
  user: string,
  files?: Array<{ name: string; source: string; image: boolean }>
): void {
  session.turnHistory.push({ user, files, events: [] });
  if (session.turnHistory.length > MAX_TURN_RECORDS) {
    session.turnHistory.splice(0, session.turnHistory.length - MAX_TURN_RECORDS);
  }
}

/** 流结束后调用：把该轮实际推送的事件挂到最后一条记录上（含被中止的部分轮） */
export function completeTurnRecord(session: Session, events: AgentEvent[]): void {
  const record = session.turnHistory.at(-1);
  if (!record) return;
  record.events = events.length > MAX_RECORD_EVENTS ? events.slice(-MAX_RECORD_EVENTS) : events;
}

export function getTurnHistory(session: Session): TurnRecord[] {
  return session.turnHistory;
}

/** 项目删除后，把其会话迁移到默认项目 */
export function moveSessions(fromProjectId: string, toProjectId: string): number {
  let moved = 0;
  for (const s of sessions.values()) {
    if (s.projectId === fromProjectId) {
      s.projectId = toProjectId;
      moved += 1;
    }
  }
  return moved;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

export function listSessions(): Session[] {
  return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
