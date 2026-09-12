/**
 * ============================================================
 * index.ts — Agent Web 服务（零框架：node:http + SSE）
 * ============================================================
 * 为什么不用 Express？
 *   一共 6 个路由 + 静态文件，node:http 足够，学习 Demo 零额外依赖更好读。
 *
 * 路由：
 *   GET  /                  前端页面（public/ 下的静态文件）
 *   GET  /api/config        模型/模式元信息（是否 mock、模型名、Demo 清单）
 *   GET  /api/sessions      会话列表
 *   POST /api/sessions      新建会话 { demo }
 *   DELETE /api/sessions/:id 删除会话
 *   POST /api/chat          发消息，SSE 流式返回 AgentEvent
 *   POST /api/resume        Demo 3 审批决定 { sessionId, decision }，SSE 流式返回
 *
 * SSE 数据帧：每行 `data: {"type":"token","text":"..."}` + 空行，与 AgentEvent 一一对应。
 * 客户端断开：通过 AbortSignal 取消图流（模型请求随之中止），保证「停止」按钮可用。
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { runGraphEvents } from "./stream.js";
import { mockRun } from "./mock.js";
import {
  createSession, deleteSession, getSession, isDemo, listSessions, DEMOS,
  rebuildIfStale, bumpConfigVersion,
} from "./sessions.js";
import type { Session } from "./sessions.js";
import { loadSettings, listProviders, getActiveId, addProvider, updateProvider, deleteProvider, activateProvider, maskKey, fetchGatewayModels, getContextWindowForActive, refreshModelInfo, getActiveModality } from "./settings.js";
import { loadProjects, listProjects, getActiveProjectId, setActiveProject, addProject, deleteProject, refreshCloudProject } from "./projects.js";
import { loadExternalAgents, listExternalAgents, getExternalAgent, addExternalAgent, updateExternalAgent, deleteExternalAgent, runExternalAgent } from "./external.js";
import { listDir, readFileAuthorized, openRemoteRoot, storeUpload, resolveChatFiles, buildUserContent } from "./files.js";
import type { ChatFileRef } from "./files.js";
import type { AgentEvent, ApprovalPayload } from "./events.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT ?? 3000);

// 启动时先叠加 Web 设置页保存的覆盖配置（.web-config.json → 覆盖 .env），
// 加载项目文件夹列表，并后台拉一次启用中供应商的模型元信息（上下文窗口长度）
await loadSettings();
await loadProjects();
await loadExternalAgents();
void refreshModelInfo().catch(() => {});
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// 静态文件（白名单式防目录穿越）
// ---------------------------------------------------------------------------
async function serveStatic(pathname: string, res: import("node:http").ServerResponse): Promise<boolean> {
  const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  if (!/^[\w.-]+$/.test(file)) return false; // 只允许单层文件名，杜绝 ../ 穿越
  try {
    const data = await readFile(join(PUBLIC_DIR, file));
    // no-store：页面与脚本始终取最新（本地学习 demo，禁用浏览器缓存，
    // 避免「更新代码后浏览器还在跑旧 app.js → 按钮点了没反应」）
    res.writeHead(200, {
      "Content-Type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSE 输出
// ---------------------------------------------------------------------------
function writeEvent(res: import("node:http").ServerResponse, event: AgentEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** 统一的流式执行器：真实图 or 模拟模型，都吐 AgentEvent */
async function streamToClient(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  session: Session,
  produce: (signal: AbortSignal) => AsyncGenerator<AgentEvent>
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const controller = new AbortController();
  let clientGone = false;
  // 客户端断开检测：ServerResponse 的 close 在「响应未写完就断连」时才是真正的中止信号
  // （req 的 close 在请求体读完时就会触发，不能用来判断断连）
  res.on("close", () => {
    if (!res.writableEnded) {
      clientGone = true;
      controller.abort();
    }
  });

  try {
    for await (const event of produce(controller.signal)) {
      if (controller.signal.aborted) break;
      writeEvent(res, event);
      if (event.type === "interrupt") session.pendingApproval = event.payload;
      if (event.type === "done") session.pendingApproval = null;
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err);
      writeEvent(res, { type: "error", message });
    }
  } finally {
    if (!clientGone) {
      writeEvent(res, { type: "done" });
      res.end();
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// 业务处理
// ---------------------------------------------------------------------------
function readBody(req: import("node:http").IncomingMessage, maxChars = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c;
      if (body.length > maxChars) reject(new Error("请求体过大"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleChat(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  sessionId: string,
  body: { message?: unknown; files?: unknown }
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启，请新建会话" }));
    return;
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "消息不能为空" }));
    return;
  }
  // 配置在会话创建后被改过 → 先用当前配置重建图（Demo 2/3 的记忆会重置）
  rebuildIfStale(session);

  // 附件：前端只传引用（项目/远程文件路径 或 上传 id），内容由服务端读取并校验。
  // 图片附件仅在启用中的模型为「多模态」时可用（否则 400 提示）。
  const fileRefs: ChatFileRef[] = Array.isArray(body.files) ? (body.files as ChatFileRef[]).slice(0, 5) : [];
  let fullMessage: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = message;
  if (fileRefs.length) {
    const attachments = await resolveChatFiles(fileRefs, getActiveModality() === "vision"); // 无效引用会抛错 → 路由转 400
    fullMessage = buildUserContent(message, attachments, getActiveModality());
  }

  // ── 外部 Agent 会话：不走 LangGraph / mock，直接启动第三方工具子进程 ──
  if (session.kind === "external") {
    const agent = getExternalAgent(session.agentId ?? "");
    if (!agent) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "该会话的外部 Agent 已被移除，请新建对话" }));
      return;
    }
    // 外部工具按纯文本接收：多模态附件只取文本部分（图片不传给第三方进程）
    const text = typeof fullMessage === "string"
      ? fullMessage
      : fullMessage.filter((p) => p.type === "text").map((p) => p.text).join("\n\n");
    await streamToClient(res, req, session, (signal) => runExternalAgent(agent, text, signal));
    return;
  }

  // 未配置 API_KEY → 模拟模式；否则跑真实图
  if (!config.apiKey) {
    session.turns += 1; // 轮次递增，供模拟用量（上下文增长 / 缓存命中率）使用
    await streamToClient(res, req, session, (signal) =>
      mockRun({ message: typeof fullMessage === "string" ? fullMessage : message, rawMessage: message, turnIndex: session.turns - 1, signal })
    );
    return;
  }

  const { HumanMessage } = await import("@langchain/core/messages");
  await streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], { messages: [new HumanMessage(fullMessage)] }, {
      threadId: session.threadId,
      signal,
    })
  );
}

async function handleResume(
  res: import("node:http").ServerResponse,
  req: import("node:http").IncomingMessage,
  sessionId: string,
  body: { decision?: unknown }
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "会话不存在或服务已重启" }));
    return;
  }
  const decision = body.decision === "approve" ? "approve" : "reject";
  const approval = session.pendingApproval;
  // 配置变更后不重建审批中的图：旧图的 interrupt 状态无法跨 checkpointer 恢复，
  // 让本次 resume 在原图上完成（配置从下一条消息起生效）
  if (!approval) rebuildIfStale(session);

  if (!config.apiKey) {
    await streamToClient(res, req, session, (signal) =>
      mockRun({ decision, approval: approval ?? undefined, turnIndex: session.turns, signal })
    );
    return;
  }

  // 真实图：用 Command({ resume }) 把决定送回被暂停的图（见 agent/hitl.ts）
  const { buildResumeCommand } = await import("../agent/hitl.js");
  await streamToClient(res, req, session, (signal) =>
    runGraphEvents(session.graph as Parameters<typeof runGraphEvents>[0], buildResumeCommand(decision as "approve" | "reject"), {
      threadId: session.threadId,
      signal,
    })
  );
}

// ---------------------------------------------------------------------------
// HTTP 入口
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  try {
    // API 响应一律禁缓存（GET /api/config 等被浏览器缓存会造成状态不同步）
    if (pathname.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");

    // --- 静态 ---
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      if (await serveStatic(pathname, res)) return;
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    // --- API ---
    if (pathname === "/api/config" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        mock: !config.apiKey,
        model: config.model,
        baseURL: config.baseURL,
        hasKey: Boolean(config.apiKey),
        keyMasked: maskKey(config.apiKey),
        providers: listProviders(),
        activeProviderId: getActiveId(),
        contextWindow: getContextWindowForActive() ?? null,
        demos: DEMOS,
      }));
      return;
    }

    // ── 供应商管理：添加 ──
    if (pathname === "/api/config/providers" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const { provider, activeChanged } = await addProvider(body);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, provider, activeChanged, mock: !config.apiKey }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── 供应商管理：更新 ──
    const providerMatch = pathname.match(/^\/api\/config\/providers\/([\w-]+)$/);
    if (providerMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const { activeChanged } = await updateProvider(providerMatch[1], body);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey, model: config.model, baseURL: config.baseURL }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── 供应商管理：删除 ──
    if (providerMatch && req.method === "DELETE") {
      try {
        const { activeChanged } = await deleteProvider(providerMatch[1]);
        if (activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeChanged, mock: !config.apiKey }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── 供应商管理：切换启用 ──
    if (pathname === "/api/config/activate" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string };
      try {
        const r = await activateProvider(body.id ?? "");
        if (r.activeChanged) {
          bumpConfigVersion();
          void refreshModelInfo().catch(() => {});
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, mock: !config.apiKey, baseURL: config.baseURL }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // 拉取网关模型列表（兼「测试连接」）：
    // { providerId } 用已存档案的 Key 测试 / { baseURL, apiKey } 用表单里未保存的值测试
    if (pathname === "/api/models" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        baseURL?: unknown; apiKey?: unknown; providerId?: unknown;
      };
      try {
        const models = await fetchGatewayModels({
          baseURL: typeof body.baseURL === "string" && body.baseURL.trim() ? body.baseURL : undefined,
          apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
          providerId: typeof body.providerId === "string" ? body.providerId : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, models, contextWindow: getContextWindowForActive() ?? null }));
      } catch (err) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
      return;
    }

    if (pathname === "/api/sessions") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(listSessions().map((s) => ({
          id: s.id, kind: s.kind, demo: s.demo, agentId: s.agentId, projectId: s.projectId, title: s.title, createdAt: s.createdAt,
          pendingApproval: Boolean(s.pendingApproval),
        }))));
        return;
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { kind?: unknown; demo?: unknown; projectId?: unknown; title?: string; agentId?: unknown };
        // 新逻辑：{ kind: "agent" }（默认）/ { kind: "demo", demo: 1-4 } / { kind: "external", agentId }
        // 兼容旧调用：只传 { demo: N } 视为示例会话
        const kind = body.kind === "demo" || body.kind === "external" || (!body.kind && isDemo(body.demo))
          ? (body.kind as "demo" | "external")
          : "agent";
        const demo = isDemo(body.demo) ? body.demo : null;
        if (kind === "demo" && !demo) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "示例会话需要 demo: 1-4" }));
          return;
        }
        const projectId = typeof body.projectId === "string" && body.projectId ? body.projectId : getActiveProjectId();
        try {
          const session = createSession(kind, demo, projectId, body.title, typeof body.agentId === "string" ? body.agentId : null);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: session.id, kind: session.kind, demo: session.demo, agentId: session.agentId, projectId: session.projectId, title: session.title, createdAt: session.createdAt }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
        return;
      }
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (sessionMatch && req.method === "DELETE") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: deleteSession(sessionMatch[1]) }));
      return;
    }

    // ── 外部 Agent（第三方 Git 仓库接入）：列表 / 接入 / 补全 / 删除 ──
    if (pathname === "/api/external-agents" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ agents: listExternalAgents() }));
      return;
    }

    if (pathname === "/api/external-agents" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        url?: string; name?: string; command?: string; args?: unknown; passCredentials?: unknown;
      };
      try {
        const r = await addExternalAgent(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...r, agents: listExternalAgents() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    const extMatch = pathname.match(/^\/api\/external-agents\/([\w-]+)$/);
    if (extMatch && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        name?: string; command?: string; args?: unknown; passCredentials?: unknown;
      };
      try {
        const agent = await updateExternalAgent(extMatch[1], body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, agent }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (extMatch && req.method === "DELETE") {
      try {
        await deleteExternalAgent(extMatch[1]);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, agents: listExternalAgents() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── 项目文件夹：列表 / 添加（本地 / 云端 Git）/ 删除 / 刷新 ──
    if (pathname === "/api/projects" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ projects: listProjects(), activeProjectId: getActiveProjectId() }));
      return;
    }

    if (pathname === "/api/projects" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; type?: string; path?: string; url?: string };
      try {
        const project = await addProject(body);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, project, projects: listProjects(), activeProjectId: getActiveProjectId() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/projects/active" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string };
      try {
        setActiveProject(body.id ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, activeProjectId: getActiveProjectId() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    const projectMatch = pathname.match(/^\/api\/projects\/([\w-]+)$/);
    if (projectMatch && req.method === "DELETE") {
      try {
        await deleteProject(projectMatch[1]);
        const moved = (await import("./sessions.js")).moveSessions(projectMatch[1], "default");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, movedSessions: moved, projects: listProjects(), activeProjectId: getActiveProjectId() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname.match(/^\/api\/projects\/([\w-]+)\/refresh$/) && req.method === "POST") {
      const id = pathname.match(/^\/api\/projects\/([\w-]+)\/refresh$/)![1];
      try {
        const p = await refreshCloudProject(id);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, project: p }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── 文件上下文：目录浏览 / 文件读取 / 远程文件夹授权 / 本地上传 ──
    // （注意：先 await 业务再 writeHead，失败才能正常回 4xx）
    if (pathname === "/api/fs/list" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await listDir(body.path);
        // roots 拼上项目信息：前端据此区分 本地💻 / 云端☁️ 样式
        const byPath = new Map(listProjects().map((p) => [p.path, p]));
        const roots = data.roots.map((r) => {
          const p = byPath.get(r.path);
          return { ...r, type: p?.type ?? "local", projectId: p?.id ?? null, url: p?.url };
        });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...data, roots }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/fs/read" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await readFileAuthorized(body.path ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/fs/open-remote" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { path?: string };
      try {
        const data = await openRemoteRoot(body.path ?? "");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...data }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/files/upload" && req.method === "POST") {
      // 图片走 dataURL，体积比文本大 → 单独放宽请求体上限
      const body = JSON.parse((await readBody(req, 12_000_000)) || "{}") as {
        name?: unknown; content?: unknown; image?: unknown;
      };
      try {
        if (typeof body.name !== "string" || typeof body.content !== "string") {
          throw new Error("参数不完整（name / content）");
        }
        const data = storeUpload(body.name, body.content, body.image === true);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, ...data }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (pathname === "/api/chat" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        sessionId?: string; message?: unknown; files?: unknown;
      };
      try {
        await handleChat(res, req, body.sessionId ?? "", body);
      } catch (err) {
        // 附件解析等前置错误 → 400（流未开始）
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }

    if (pathname === "/api/resume" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { sessionId?: string; decision?: unknown };
      await handleResume(res, req, body.sessionId ?? "", body);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not Found" }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, async () => {
  const mode = config.apiKey ? "真实模型" : "模拟模式（未配置 API_KEY）";
  console.log(
    `\n  LangGraph Agent Web 已启动\n` +
    `  ➜  http://localhost:${PORT}\n` +
    `  模式: ${mode}   模型: ${config.model}   网关: ${config.baseURL}\n` +
    `  提示: 右上角 ⚙ 设置 可在线修改供应商 / API Key / 模型\n`
  );
});
