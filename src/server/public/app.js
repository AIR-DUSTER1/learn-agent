/* ============================================================
   app.js — LangGraph Agent 学习 Demo 前端
   参考 ZCode 聊天界面：流式回答 / 工具调用卡片 / 人工审批 / 会话侧栏
   无框架、无构建：原生 JS + SSE
   ============================================================ */
"use strict";

/** 前端版本标记：改动 app.js 后递增，用于确认浏览器跑的是不是最新脚本 */
const APP_VERSION = "web-2026-09-12-16";
console.log(
  "%c[LangGraph Demo] 前端脚本已加载 " + APP_VERSION,
  "color:#fff;background:#5b8cff;padding:2px 8px;border-radius:4px"
);

/** 全局错误可见化：任何未捕获异常都在页面上挂红色横幅（不再只进控制台） */
function showFatalBanner(message) {
  let banner = document.getElementById("fatal-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "fatal-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9999;background:#e5604f;color:#fff;" +
      "padding:8px 14px;font-size:12.5px;font-family:monospace;white-space:pre-wrap;" +
      "word-break:break-all;max-height:40vh;overflow:auto;";
    document.body.appendChild(banner);
  }
  banner.textContent = "⚠ 页面脚本错误（把这段文字发给助手排查）： " + message;
}
window.addEventListener("error", (e) => showFatalBanner(e.message));
window.addEventListener("unhandledrejection", (e) => showFatalBanner(String(e.reason)));

/* ---------------------------------------------------------------------------
 * 全局状态
 * ------------------------------------------------------------------------- */
const state = {
  config: null,        // { mock, model, baseURL, contextWindow, providers, demos }
  sessions: [],        // { id, kind, demo, agentId, projectId, title, createdAt, stale?, pendingApproval? }
  projects: [],        // [{id, name, type:"local"|"cloud", path, url?, builtin?}]
  externalAgents: [],  // [{id, name, url, command, args, ...}] 第三方接入的 Agent
  projectView: "all",  // "all" | projectId（侧栏过滤 + 新建会话归属）
  currentId: null,
  blocks: {},          // sessionId -> [block]
  usage: {},           // sessionId -> { contextTokens, lastInput, lastOutput, lastCache }
  streaming: null,     // { ctrl, sid, ablock }
};

/** 流式期间每个 part 对应的 DOM 引用（内存 Map，不参与持久化） */
const partEls = new Map();      // part -> 渲染所需 DOM 引用
const blockBodies = new Map();  // assistant block -> 正文容器
const textTimers = new Map();   // part -> 节流定时器
const usageEls = new Map();     // assistant block -> 用量小字元素

const LS_TRANSCRIPTS = "lg-agent-transcripts";
const LS_SESSIONS = "lg-agent-sessions-meta";
const LS_USAGE = "lg-agent-usage";
const LS_PROJECT_VIEW = "lg-agent-project-view";
const LS_THEME = "lg-agent-theme";

/* ---------------------------------------------------------------------------
 * 主题切换：深色（默认）/ 浅色。html[data-theme] 驱动 CSS 变量整体换肤；
 * localStorage 持久化，<head> 里的内联脚本在样式应用前恢复，避免闪白/闪黑。
 * ------------------------------------------------------------------------- */
function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function updateThemeBtn() {
  const btn = $("theme-btn");
  if (!btn) return;
  const light = currentTheme() === "light";
  btn.textContent = light ? "🌙" : "☀️";
  btn.title = light ? "切换到深色主题" : "切换到浅色主题";
}

function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  if (next === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(LS_THEME, next); } catch { /* 隐私模式等 */ }
  updateThemeBtn();
}

/* ---------------------------------------------------------------------------
 * 窄屏抽屉式侧栏：☰ 开关 + 遮罩点击关闭；选中会话/项目后自动收起。
 * 桌面宽屏下侧栏常驻，open 类只在 ≤860px 媒体查询里有样式效果。
 * ------------------------------------------------------------------------- */
function setSidebarOpen(open) {
  const sb = $("sidebar");
  if (!sb) return;
  sb.classList.toggle("open", open);
  const scrim = $("sidebar-scrim");
  if (scrim) scrim.classList.toggle("hidden", !open);
}

/* ---------------------------------------------------------------------------
 * DOM 快捷方式
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const chatScroll = $("chat-scroll");
const messagesEl = $("messages");
const welcomeEl = $("welcome");
const inputEl = $("input");
const sendBtn = $("send-btn");
const stopBtn = $("stop-btn");

const DEMO_BADGE_TEXT = { 1: "示例 1 · 基础 ReAct", 2: "示例 2 · 对话记忆", 3: "示例 3 · 人工审批", 4: "示例 4 · 多 Agent" };
/** 请求协议 → 徽标短文案（openai 是默认，不显示徽标） */
const PROTOCOL_LABEL = {
  "openai-responses": "Responses",
  "anthropic": "Anthropic",
  "gemini": "Gemini",
};
const TOOL_ICONS = { calculator: "🧮", get_weather: "☁️", get_current_time: "⏰", send_email: "📧", delegate: "🧭" };
const NODE_ICONS = { agent: "🧠", tools: "🔧", supervisor: "👔", researcher: "🔍", writer: "✍️" };

/* ---------------------------------------------------------------------------
 * 通用弹窗组件 —— 替代原生 alert / prompt / confirm。
 * 原生对话框被部分浏览器环境（自动化参数、企业策略）拦截或样式突兀，
 * 这里用页面内组件实现同样语义：Promise 化，await 后拿结果。
 *   uiAlert(msg)            → 关闭后 resolve
 *   uiConfirm(msg, opts)    → 确定 true / 取消 false
 *   uiPrompt(msg, opts)     → 确定 返回输入串（可能为空串）/ 取消 null
 * 多个弹窗请求会串行排队展示，不会相互覆盖。
 * ------------------------------------------------------------------------- */
const uiDialogState = { open: false, queue: [], mode: null, resolve: null };

function uiDialog(options) {
  return new Promise((resolve) => {
    uiDialogState.queue.push({ options, resolve });
    if (!uiDialogState.open) uiDialogShowNext();
  });
}

function uiDialogShowNext() {
  const next = uiDialogState.queue.shift();
  const mask = $("ui-dialog-mask");
  if (!next || !mask) { uiDialogState.open = false; return; }
  uiDialogState.open = true;
  const { title, message, mode, defaultValue = "", placeholder = "", okText, cancelText, danger } = next.options;
  $("ui-dialog-title").textContent = title || (mode === "confirm" ? "请确认" : "提示");
  const msgEl = $("ui-dialog-msg");
  msgEl.textContent = message; // textContent 防注入；CSS pre-wrap 保留换行
  const inputRow = $("ui-dialog-input-row");
  const input = $("ui-dialog-input");
  inputRow.classList.toggle("hidden", mode !== "prompt");
  input.value = defaultValue;
  input.placeholder = placeholder;
  const okBtn = $("ui-dialog-ok");
  okBtn.textContent = okText || (mode === "alert" ? "知道了" : "确定");
  okBtn.className = "btn " + (danger ? "btn-danger" : "btn-approve");
  const cancelBtn = $("ui-dialog-cancel");
  cancelBtn.textContent = cancelText || "取消";
  cancelBtn.classList.toggle("hidden", mode === "alert");
  uiDialogState.mode = mode;
  uiDialogState.resolve = next.resolve;
  mask.classList.remove("hidden");
  if (mode === "prompt") { input.focus(); input.select(); }
  else okBtn.focus();
}

/** 关闭当前弹窗并回传结果；队列里还有就继续展示下一个 */
function uiDialogFinish(value) {
  if (!uiDialogState.open) return;
  const resolve = uiDialogState.resolve;
  $("ui-dialog-mask").classList.add("hidden");
  uiDialogState.resolve = null;
  uiDialogState.mode = null;
  uiDialogState.open = false;
  resolve(value);
  uiDialogShowNext();
}

function uiAlert(message, title) {
  return uiDialog({ message, title, mode: "alert" });
}
function uiConfirm(message, opts = {}) {
  return uiDialog({ message, mode: "confirm", ...opts });
}
function uiPrompt(message, opts = {}) {
  return uiDialog({ message, mode: "prompt", ...opts });
}

// 组件事件绑定（脚本在 body 末尾加载，元素此时已存在）
(() => {
  const mask = $("ui-dialog-mask");
  if (!mask) { console.warn("[ui-dialog] 未找到弹窗骨架，原生对话框将被兜底使用"); return; }
  const finishCancel = () => uiDialogFinish(uiDialogState.mode === "prompt" ? null : false);
  $("ui-dialog-ok").addEventListener("click", () => {
    uiDialogFinish(uiDialogState.mode === "prompt" ? $("ui-dialog-input").value : true);
  });
  $("ui-dialog-cancel").addEventListener("click", finishCancel);
  mask.addEventListener("click", (e) => { if (e.target === mask) finishCancel(); });
  mask.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      uiDialogFinish(uiDialogState.mode === "prompt" ? $("ui-dialog-input").value : true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishCancel();
    }
  });
})();

/** 通用 Agent 的常规示例（点击 → 新建通用 Agent 会话并预填） */
const GENERAL_EXAMPLES = [
  "帮我算一下 (128+512)*3，再看看现在几点了",
  "查一下北京的天气，适合穿什么",
  "给 boss@example.com 发一封邮件，主题是周报",
  "附加一个文件，帮我总结它的要点（用 📎 选择）",
];

function nodeIcon(name) { return NODE_ICONS[name.split("/")[0]] || "⚙️"; }

/* ---------------------------------------------------------------------------
 * Markdown 渲染（零依赖迷你实现：先转义再解析，天然防注入）
 * 支持：围栏代码块 / 行内代码 / 加粗斜体 / 链接 / 标题 / 列表 / 引用 / 表格 / 分割线
 * 对「流式中途未闭合的围栏」也能正确渲染成代码块。
 * ------------------------------------------------------------------------- */
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(text) {
  let h = escapeHtml(text);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}

function renderMarkdown(src) {
  const fences = [];
  // 1. 提取围栏代码块（含未闭合的流式半截）
  src = src.replace(/```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    fences.push({ lang, code: code.replace(/\n$/, "") });
    return `\u0000F${fences.length - 1}\u0000`;
  });

  // 2. 逐行做块级解析
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  const isFence = (l) => /^\u0000F\d+\u0000\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) { out.push(line); i++; continue; }
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { out.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); i++; continue; }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }

    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      // buf 至少含当前行（入口已匹配 >），循环内每轮 i++，必然终止
      out.push(`<blockquote>${buf.map(renderInline).join("<br>")}</blockquote>`);
      continue;
    }

    // 表格：| a | b | 换行 |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|?\s*$/.test(lines[i]) && lines[i].includes("|")) { rows.push(parseRow(lines[i])); i++; }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>` +
        `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }

    // 列表
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(ul ? /^\s*[-*]\s+(.*)$/ : /^\s*\d+[.、]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i++;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // 普通段落（连续非空行，行间以 <br> 连接）
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isFence(lines[i]) &&
      !/^(#{1,4})\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+[.、]\s+/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i]) &&
      !/^\s*>/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) {
      out.push(`<p>${buf.map(renderInline).join("<br>")}</p>`);
    } else {
      // 兜底：当前行不属于任何块（如流式中的半截表格行），直接按段落输出，保证 i 前进
      out.push(`<p>${renderInline(lines[i])}</p>`);
      i++;
    }
  }

  let html = out.join("\n");
  // 3. 还原代码块
  html = html.replace(/\u0000F(\d+)\u0000/g, (_m, n) => {
    const f = fences[Number(n)];
    return `<pre><code>${escapeHtml(f.code)}</code></pre>`;
  });
  return html;
}

/* ---------------------------------------------------------------------------
 * 会话持久化（localStorage）—— 服务端会话是内存态，重启即失；
 * 前端负责把对话内容留在本地，刷新/重启后仍可查看历史。
 * ------------------------------------------------------------------------- */
function loadLocal() {
  try {
    state.blocks = JSON.parse(localStorage.getItem(LS_TRANSCRIPTS) || "{}");
  } catch { state.blocks = {}; }
  try {
    state.usage = JSON.parse(localStorage.getItem(LS_USAGE) || "{}");
  } catch { state.usage = {}; }
  state.projectView = localStorage.getItem(LS_PROJECT_VIEW) || "all";
}
function saveLocal() {
  clearTimeout(saveLocal._t);
  saveLocal._t = setTimeout(() => {
    try {
      localStorage.setItem(LS_TRANSCRIPTS, JSON.stringify(state.blocks));
      localStorage.setItem(LS_USAGE, JSON.stringify(state.usage));
      localStorage.setItem(LS_PROJECT_VIEW, state.projectView);
      localStorage.setItem(LS_SESSIONS, JSON.stringify(
        state.sessions.map((s) => ({ id: s.id, kind: s.kind, title: s.title, demo: s.demo, projectId: s.projectId, createdAt: s.createdAt }))
      ));
    } catch { /* 存储已满等场景忽略 */ }
  }, 300);
}
function transcript(sid) {
  if (!state.blocks[sid]) state.blocks[sid] = [];
  return state.blocks[sid];
}

/* ---------------------------------------------------------------------------
 * API 封装
 * ------------------------------------------------------------------------- */
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ---------------------------------------------------------------------------
 * 项目文件夹（本地 💻 / 云端 ☁️ Git 仓库）
 * ------------------------------------------------------------------------- */
function projectById(id) {
  return state.projects.find((p) => p.id === id);
}

function projectIcon(p) { return p?.type === "cloud" ? "☁️" : "📁"; }

async function loadProjects() {
  try {
    const data = await api("/api/projects");
    state.projects = data.projects || [];
    if (state.projectView !== "all" && !projectById(state.projectView)) state.projectView = "all";
    renderProjectSwitcher();
    renderSessions();
  } catch { /* 服务重启等 */ }
}

function showProjectMenu(show) {
  $("project-menu").classList.toggle("hidden", !show);
}

function renderProjectSwitcher() {
  const view = state.projectView;
  const active = view === "all" ? null : projectById(view);
  $("project-btn-icon").textContent = active ? projectIcon(active) : "🗂";
  $("project-btn-text").textContent = active ? active.name : "全部项目";

  const menu = $("project-menu");
  menu.innerHTML = "";

  const all = document.createElement("button");
  all.className = "pm-item" + (view === "all" ? " active" : "");
  all.innerHTML = `<span class="pm-ic">🗂</span><span>全部项目</span><span class="pm-check">${view === "all" ? "✓" : ""}</span>`;
  all.addEventListener("click", async () => { state.projectView = "all"; saveLocal(); showProjectMenu(false); setSidebarOpen(false); renderProjectSwitcher(); renderSessions(); });
  menu.appendChild(all);

  for (const p of state.projects) {
    const item = document.createElement("div");
    item.className = "pm-item" + (view === p.id ? " active" : "");
    item.style.display = "flex";
    item.innerHTML = `
      <span class="pm-ic">${projectIcon(p)}</span>
      <span class="pm-name" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
      <span class="pm-sub ${p.type}">${p.type === "cloud" ? "云端" : "本地"}</span>
      ${p.type === "cloud" ? '<button class="pm-x pm-refresh" title="git pull 刷新缓存">⟳</button>' : ""}
      ${p.builtin ? "" : '<button class="pm-x pm-del" title="删除项目">✕</button>'}
      <span class="pm-check">${view === p.id ? "✓" : ""}</span>`;
    item.querySelector(".pm-name").textContent = p.name;
    item.addEventListener("click", (e) => {
      if (e.target.closest(".pm-x")) return; // 删除/刷新按钮单独处理
      state.projectView = p.id;
      saveLocal();
      showProjectMenu(false);
      setSidebarOpen(false); // 窄屏抽屉：选中项目即收起
      renderProjectSwitcher();
      renderSessions();
    });
    const refresh = item.querySelector(".pm-refresh");
    if (refresh) refresh.addEventListener("click", async (e) => {
      e.stopPropagation();
      refresh.textContent = "…";
      try {
        await api(`/api/projects/${p.id}/refresh`, { method: "POST" });
      } catch (err) { uiAlert(`刷新失败：${err.message}`, "刷新云端文件夹"); }
      refresh.textContent = "⟳";
    });
    const del = item.querySelector(".pm-del");
    if (del) del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await uiConfirm(
        `删除项目「${p.name}」？${p.type === "cloud" ? "\n云端缓存副本将一并删除。" : ""}\n其会话会迁移到 learn-agent 项目。`,
        { title: "删除项目", okText: "删除", danger: true }
      );
      if (!ok) return;
      try {
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        await loadProjects();
        if (state.projectView === p.id) { state.projectView = "all"; saveLocal(); }
        renderProjectSwitcher();
        renderSessions();
      } catch (err) { uiAlert(`删除失败：${err.message}`, "删除项目"); }
    });
    menu.appendChild(item);
  }

  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);

  const addLocal = document.createElement("button");
  addLocal.className = "pm-item pm-manage";
  addLocal.textContent = "💻 添加本地文件夹（服务器路径）";
  addLocal.addEventListener("click", () => { showProjectMenu(false); addProjectFolder("local"); });
  menu.appendChild(addLocal);

  const addCloud = document.createElement("button");
  addCloud.className = "pm-item pm-manage";
  addCloud.textContent = "☁️ 添加云端文件夹（Git 仓库）";
  addCloud.addEventListener("click", () => { showProjectMenu(false); addProjectFolder("cloud"); });
  menu.appendChild(addCloud);
}

async function addProjectFolder(type) {
  let body;
  if (type === "cloud") {
    const url = await uiPrompt(
      "输入云端 Git 仓库地址（将自动 clone 到本地缓存）：\n例如 https://github.com/user/repo.git",
      { title: "添加云端文件夹（Git 仓库）", placeholder: "https://github.com/user/repo.git" }
    );
    if (!url || !url.trim()) return;
    const name = await uiPrompt("项目显示名称（留空则取仓库名）：", {
      title: "添加云端文件夹（Git 仓库）",
      placeholder: "留空 = 取仓库名",
    });
    body = { type: "cloud", url: url.trim(), name: name?.trim() || undefined };
  } else {
    const path = await uiPrompt(
      "输入服务器上的文件夹绝对路径：\n⚠ 这会把该目录暴露给网页端浏览，仅建议本地/可信环境使用",
      { title: "添加本地文件夹（服务器路径）", placeholder: "例如 E:\\study 或 /home/user/project" }
    );
    if (!path || !path.trim()) return;
    body = { type: "local", path: path.trim() };
  }
  try {
    const res = await api("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.projects = res.projects;
    state.projectView = res.project.id;
    saveLocal();
    renderProjectSwitcher();
    renderSessions();
  } catch (err) {
    uiAlert(`${type === "cloud" ? "云端仓库" : "本地文件夹"}添加失败：${err.message}`, "添加项目");
  }
}

/* ---------------------------------------------------------------------------
 * 侧栏会话列表（按项目分组）
 * ------------------------------------------------------------------------- */
function renderSessions() {
  const list = $("session-list");
  list.innerHTML = "";

  // 按项目过滤 + 分组（保持 projects 定义顺序；无匹配项目的会话归入「其他」）
  const filtered = state.sessions.filter(
    (s) => state.projectView === "all" || s.projectId === state.projectView
  );
  const groups = [];
  const byId = new Map();
  for (const p of state.projects) {
    const g = { project: p, sessions: [] };
    groups.push(g);
    byId.set(p.id, g);
  }
  const other = { project: null, sessions: [] };
  for (const s of filtered) {
    (byId.get(s.projectId) || other).sessions.push(s);
  }
  if (other.sessions.length) groups.push(other);

  for (const g of groups) {
    if (!g.sessions.length) continue;
    const head = document.createElement("div");
    head.className = "proj-group-head" + (g.project?.type === "cloud" ? " cloud" : "");
    head.innerHTML = `<span class="g-icon">${g.project ? projectIcon(g.project) : "📁"}</span><span class="g-name"></span><span class="p-type-tag">${g.project ? (g.project.type === "cloud" ? "云端" : "本地") : "已移除"}</span>`;
    head.querySelector(".g-name").textContent = g.project?.name ?? "未归属";
    list.appendChild(head);
    for (const s of g.sessions) list.appendChild(renderSessionItem(s));
  }
  if (!list.children.length) {
    const empty = document.createElement("div");
    empty.className = "fs-empty";
    empty.textContent = state.projectView === "all" ? "还没有会话，点上方「＋ 新建对话」" : "该项目下还没有会话";
    list.appendChild(empty);
  }
}

function renderSessionItem(s) {
  const item = document.createElement("div");
  item.className = "session-item" + (s.id === state.currentId ? " active" : "") + (s.stale ? " stale" : "");
  item.title = s.stale ? "服务已重启，该会话仅可查看历史记录" : "";

  const title = document.createElement("div");
  title.className = "s-title";
  title.textContent = s.title;
  item.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "s-meta";
  const tag = document.createElement("span");
  tag.className = "s-demo";
  tag.textContent = s.kind === "agent" ? "通用" : s.kind === "external" ? "外部" : `示例 ${s.demo}`;
  meta.appendChild(tag);
  const time = document.createElement("span");
  time.textContent = new Date(s.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  meta.appendChild(time);
  if (s.pendingApproval) {
    const pend = document.createElement("span");
    pend.textContent = "⏸ 待审批";
    pend.style.color = "var(--amber)";
    meta.appendChild(pend);
  }
  item.appendChild(meta);

  const del = document.createElement("button");
  del.className = "s-del";
  del.textContent = "✕";
  del.title = "删除会话";
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!s.stale) { try { await api(`/api/sessions/${s.id}`, { method: "DELETE" }); } catch { /* 忽略 */ } }
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    delete state.blocks[s.id];
    saveLocal();
    if (state.currentId === s.id) {
      state.currentId = null;
      renderSessions();
      showWelcomeState();
    } else {
      renderSessions();
    }
  });
  item.appendChild(del);

  item.addEventListener("click", () => selectSession(s.id));
  return item;
}

/* ---------------------------------------------------------------------------
 * 会话选择 / 新建 / 欢迎页
 * ------------------------------------------------------------------------- */
function showWelcomeState() {
  $("session-title").textContent = "未选择会话";
  $("demo-badge").classList.add("hidden");
  welcomeEl.classList.remove("hidden");
  messagesEl.innerHTML = "";
  $("context-bar").classList.add("hidden");
  inputEl.disabled = true;
  sendBtn.disabled = true;
  inputEl.placeholder = "先选择一个 Demo 新建会话…";
}

function showChatState(session) {
  welcomeEl.classList.add("hidden");
  $("session-title").textContent = session.title;
  const badge = $("demo-badge");
  badge.textContent = session.kind === "demo"
    ? (DEMO_BADGE_TEXT[session.demo] || `示例 ${session.demo}`)
    : session.kind === "external"
      ? `🔌 外部 · ${state.externalAgents.find((a) => a.id === session.agentId)?.name ?? "Agent"}`
      : "通用 Agent";
  badge.classList.remove("hidden");
  // 历史会话（服务重启后仅存于本地）只读：发送必然 404，直接禁用输入
  const stale = Boolean(session.stale);
  inputEl.disabled = stale;
  sendBtn.disabled = stale;
  inputEl.placeholder = stale
    ? "这是历史会话（服务已重启），仅供查看 —— 点击「＋ 新建对话」继续"
    : "给 Agent 发送消息…（Enter 发送 / Shift+Enter 换行）";
}

function selectSession(sid) {
  if (state.streaming) { uiAlert("当前正在生成回复，请先停止或等待完成", "请稍候"); return; }
  state.currentId = sid;
  setSidebarOpen(false); // 窄屏抽屉：选中即收起
  const s = state.sessions.find((x) => x.id === sid);
  renderSessions();
  renderAll();
  if (s) showChatState(s);
  updateContextBar();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  hydrateFromServer(s); // 本地没有该会话的记录 → 从服务端拉取回放（修复历史会话打开为空）
}

/** 历史会话回放：localStorage 里没有这个会话的对话记录时（换浏览器 / 清过缓存），
 *  从服务端拉取每轮「用户消息 + 事件流」，用与实时流完全相同的 handleEvent 重放渲染。 */
async function hydrateFromServer(s) {
  if (!s || s.stale) return;                       // 服务重启后的残留会话：服务端也没有记录
  if (transcript(s.id).length) return;             // 本地已有 → 不拉
  try {
    const data = await api(`/api/sessions/${s.id}/transcript`);
    const arr = transcript(s.id);
    if (arr.length) return;                        // 竞态防护：等待期间本地已写入
    for (const rec of data.records || []) {
      const userBlock = { t: "user", text: rec.user, ...(rec.files?.length ? { files: rec.files } : {}) };
      const ablock = { t: "assistant", parts: [] };
      arr.push(userBlock, ablock);
      for (const ev of rec.events || []) handleEvent(ev, ablock);
      finalize(ablock);
    }
    saveLocal();
    if (state.currentId === s.id) {
      renderAll();
      updateContextBar();
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }
    // 回放中的 interrupt 事件会把会话标成「待审批」——以服务端的真实状态纠正
    // （审批早已处理过时，重放的那次 interrupt 只是历史记录）
    if (typeof data.pendingApproval === "boolean") {
      s.pendingApproval = data.pendingApproval;
      renderSessions();
    }
  } catch { /* 服务端也没有记录（会话从未对话过 / 服务重启过）→ 保持现状 */ }
}

async function createSession(kind, demo, prefill, agentId) {
  // 新会话归属当前选中的项目（「全部项目」视图下归到默认项目）
  const projectId = state.projectView !== "all" ? state.projectView : "default";
  const data = await api("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(demo
      ? { kind: "demo", demo, projectId }
      : { kind: kind || "agent", projectId, ...(kind === "external" ? { agentId, title: prefill || undefined } : {}) }),
  });
  state.sessions.unshift({ ...data, stale: false });
  state.currentId = data.id;
  renderSessions();
  showChatState(state.sessions[0]);
  renderAll();
  closeModal();
  if (prefill) {
    inputEl.value = prefill;
    autoGrow();
    inputEl.focus();
  }
}

/* ---------------------------------------------------------------------------
 * 外部 Agent（第三方 Git 仓库接入）
 * ------------------------------------------------------------------------- */
async function loadExternalAgents() {
  try {
    state.externalAgents = (await api("/api/external-agents")).agents || [];
  } catch {
    state.externalAgents = []; // 旧服务进程没有该接口 → 静默降级
  }
  renderExternalCards();
}

function renderExternalCards() {
  const wrap = $("external-cards");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!state.externalAgents.length) {
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = "还没有接入外部 Agent —— 粘贴一个 Git 仓库地址即可（仓库里放一份 agent.json 说明如何启动效果最佳）";
    wrap.appendChild(empty);
    return;
  }
  for (const a of state.externalAgents) {
    const card = document.createElement("button");
    card.className = "demo-card ext-card" + (a.command ? "" : " ext-incomplete");
    card.type = "button";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">🔌</span><span class="d-name"></span>
        <button class="ext-del" title="移除该外部 Agent">✕</button></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    card.querySelector(".d-name").textContent = a.name;
    card.querySelector(".d-desc").textContent = a.description || a.url;
    card.querySelector(".d-eg").textContent = a.command
      ? `$ ${a.command} ${a.args.join(" ")}`
      : "⚠ 待补全启动命令";
    card.querySelector(".ext-del").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await uiConfirm(`移除外部 Agent「${a.name}」？\n其 clone 缓存会一并删除；已创建的会话将无法继续发送。`, { title: "移除外部 Agent", okText: "移除", danger: true }))) return;
      try {
        const res = await api(`/api/external-agents/${a.id}`, { method: "DELETE" });
        state.externalAgents = res.agents || [];
        renderExternalCards();
      } catch (err) { uiAlert(`移除失败：${err.message}`, "外部 Agent"); }
    });
    card.addEventListener("click", async () => {
      try {
        if (!a.command) {
          await completeExternalAgent(a); // 待补全：先要一条启动命令
          return;
        }
        await createSession("external", null, null, a.id);
      } catch (err) { uiAlert("创建外部 Agent 会话失败：" + err.message, "外部 Agent"); }
    });
    wrap.appendChild(card);
  }
}

/** 接入流程：Git 地址 → clone + 自动发现 → 必要时补启动命令 */
async function addExternalFlow() {
  const url = await uiPrompt(
    "输入第三方 Agent 的 Git 仓库地址：\n服务端会 clone 到本地并自动识别启动方式（agent.json > package.json > 常见入口）",
    { title: "接入外部 Agent", placeholder: "https://github.com/user/agent-repo" }
  );
  if (!url || !url.trim()) return;
  const addBtn = $("add-external-btn");
  const prevText = addBtn?.textContent;
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = "⏳ 克隆中…（最长 2 分钟）"; }
  try {
    const res = await api("/api/external-agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() }),
    });
    state.externalAgents = res.agents || [];
    renderExternalCards();
    if (res.agent.command) {
      await uiAlert(
        `已接入「${res.agent.name}」\n启动命令：${res.agent.command} ${res.agent.args.join(" ")}${res.hint ? `\n\n${res.hint}` : ""}`,
        "接入成功"
      );
    } else {
      await uiAlert(`仓库已 clone，但没有识别出启动方式。\n${res.hint || ""}`, "需要补全启动命令");
      await completeExternalAgent(res.agent);
    }
  } catch (err) {
    uiAlert(`接入失败：${err.message}`, "外部 Agent");
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = prevText ?? "＋ 接入外部 Agent（Git 地址）"; }
  }
}

/** 为「待补全」的外部 Agent 询问并保存启动命令（如 node cli.js） */
async function completeExternalAgent(agent) {
  const cmdLine = await uiPrompt(
    `为「${agent.name}」输入启动命令（在仓库目录内执行）：\n用户消息会替换 args 里的 {{prompt}} 占位符；没有占位符时通过 stdin 传入`,
    { title: "补全启动命令", placeholder: "例如 node cli.js --prompt {{prompt}}" }
  );
  if (!cmdLine || !cmdLine.trim()) return;
  const parts = cmdLine.trim().split(/\s+/);
  try {
    const res = await api(`/api/external-agents/${agent.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: parts[0], args: parts.slice(1) }),
    });
    const idx = state.externalAgents.findIndex((x) => x.id === agent.id);
    if (idx >= 0) state.externalAgents[idx] = res.agent;
    renderExternalCards();
    await createSession("external", null, null, agent.id);
  } catch (err) {
    uiAlert(`保存失败：${err.message}`, "外部 Agent");
  }
}

/* ---------------------------------------------------------------------------
 * 消息渲染（全量）
 * ------------------------------------------------------------------------- */
function renderAll() {
  messagesEl.innerHTML = "";
  partEls.clear();
  blockBodies.clear();
  const sid = state.currentId;
  if (!sid) return;
  for (const block of transcript(sid)) mountBlock(block);
  scrollBottom(true);
}

/** 把一个 block 挂到消息流末尾 */
function mountBlock(block) {
  if (block.t === "user") {
    const wrap = document.createElement("div");
    wrap.className = "msg-user";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // 附件 chips（文件上下文来源：项目 / 远程 / 本地上传）
    if (block.files?.length) {
      const chips = document.createElement("div");
      chips.className = "f-chips";
      for (const f of block.files) {
        const c = document.createElement("span");
        c.className = "f-chip";
        c.innerHTML = `${f.image ? "🖼" : "📎"} <span class="fname"></span><span class="fsrc"></span>`;
        c.querySelector(".fname").textContent = f.name;
        c.querySelector(".fsrc").textContent = f.source;
        chips.appendChild(c);
      }
      bubble.appendChild(chips);
    }
    const textDiv = document.createElement("div");
    textDiv.textContent = block.text;
    bubble.appendChild(textDiv);
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    block._el = wrap;
    return;
  }
  if (block.t === "error") {
    const el = document.createElement("div");
    el.className = "error-block";
    el.textContent = "⚠️ " + block.text;
    messagesEl.appendChild(el);
    block._el = el;
    return;
  }
  // assistant
  const wrap = document.createElement("div");
  wrap.className = "msg-assistant";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "⚡";
  const body = document.createElement("div");
  body.className = "assistant-body";
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  messagesEl.appendChild(wrap);
  block._el = wrap;
  blockBodies.set(block, body);

  for (const part of block.parts) mountPart(block, part);
  if (!block.parts.length) mountTyping(block);
  if (block._usage) updateTurnCaption(block);
}

function mountTyping(block) {
  const body = blockBodies.get(block);
  if (!body || block._typing) return;
  const t = document.createElement("div");
  t.className = "typing";
  t.innerHTML = "<i></i><i></i><i></i>";
  body.appendChild(t);
  block._typing = t;
}
function unmountTyping(block) {
  if (block._typing) { block._typing.remove(); block._typing = null; }
}

/** 把一个 part 挂到 assistant 正文里，并记录 DOM 引用 */
function mountPart(block, part) {
  const body = blockBodies.get(block);
  if (!body) return;
  unmountTyping(block);

  if (part.p === "text") {
    const el = document.createElement("div");
    el.className = "md";
    body.appendChild(el);
    partEls.set(part, { el });
    renderTextPart(part);
    return;
  }

  if (part.p === "node") {
    const chip = document.createElement("span");
    chip.className = "node-chip";
    chip.textContent = `${nodeIcon(part.name)} ${part.name}`;
    const row = document.createElement("div");
    row.appendChild(chip);
    body.appendChild(row);
    partEls.set(part, { el: row });
    return;
  }

  if (part.p === "tool") {
    const card = document.createElement("div");
    card.className = "tool-card running";
    card.innerHTML = `
      <div class="tool-head">
        <span class="tool-icon"></span>
        <span class="tool-name"></span>
        <span class="tool-args-preview"></span>
        <span class="tool-status"><span class="spinner"></span>运行中</span>
        <span class="chevron">▶</span>
      </div>
      <div class="tool-body">
        <div class="tool-section"><div class="tool-label">参数 (流式)</div><pre class="args-pre"></pre></div>
        <div class="tool-section"><div class="tool-label">结果</div><pre class="result-pre">…</pre></div>
      </div>`;
    card.querySelector(".tool-icon").textContent = TOOL_ICONS[part.name] || "🔧";
    card.querySelector(".tool-name").textContent = part.name || "tool";
    card.querySelector(".tool-head").addEventListener("click", () => card.classList.toggle("open"));
    body.appendChild(card);
    partEls.set(part, { el: card });
    updateToolCard(part);
    return;
  }

  if (part.p === "approval") {
    const el = document.createElement("div");
    el.className = "approval-card";
    renderApprovalCard(part, el);
    body.appendChild(el);
    partEls.set(part, { el });
    return;
  }
}

function renderTextPart(part) {
  const refs = partEls.get(part);
  if (!refs) return;
  refs.el.innerHTML = renderMarkdown(part.text) + (part.streaming ? '<span class="cursor"></span>' : "");
}

function fmtArgs(part) {
  try { return JSON.stringify(JSON.parse(part.argsText), null, 2); } catch { return part.argsText || "…"; }
}

function updateToolCard(part) {
  const refs = partEls.get(part);
  if (!refs) return;
  const card = refs.el;
  const firstLine = (part.result?.content || part.argsText || "").split("\n")[0] || "";
  card.querySelector(".tool-args-preview").textContent = firstLine.slice(0, 120);
  const argsPre = card.querySelector(".args-pre");
  argsPre.textContent = fmtArgs(part);

  const status = card.querySelector(".tool-status");
  if (part.result) {
    card.classList.remove("running");
    card.classList.add(part.result.isError ? "err" : "ok");
    status.className = "tool-status " + (part.result.isError ? "err" : "ok");
    status.innerHTML = part.result.isError ? "✕ 失败" : "✓ 完成";
    card.querySelector(".result-pre").textContent = part.result.content;
    card.querySelector(".result-pre").className = "result-pre" + (part.result.isError ? " err" : "");
  }
}

function renderApprovalCard(part, el) {
  const req = part.req;
  el.innerHTML = `
    <div class="approval-title">🛂 需要人工审批（Human-in-the-loop）</div>
    <div class="approval-desc"></div>
    <div class="approval-args"></div>
    <div class="approval-actions"></div>`;
  el.querySelector(".approval-desc").textContent = `Agent 请求执行高风险工具「${req.toolName}」：${req.description}`;
  el.querySelector(".approval-args").textContent = JSON.stringify(req.args, null, 2);
  const actions = el.querySelector(".approval-actions");

  if (part.status === "pending") {
    const ok = document.createElement("button");
    ok.className = "btn btn-approve";
    ok.textContent = "✓ 批准并执行";
    ok.addEventListener("click", () => decideApproval(part, "approved"));
    const no = document.createElement("button");
    no.className = "btn btn-reject";
    no.textContent = "✕ 拒绝";
    no.addEventListener("click", () => decideApproval(part, "rejected"));
    actions.append(ok, no);
  } else {
    el.classList.add(part.status === "approved" ? "done-approve" : "done-reject");
    const v = document.createElement("div");
    v.className = "approval-verdict";
    v.textContent = part.status === "approved" ? "✅ 你批准了本次操作" : "🚫 你拒绝了本次操作";
    actions.appendChild(v);
  }
}

/* ---------------------------------------------------------------------------
 * 流式事件挂载（增量）
 * ------------------------------------------------------------------------- */
function appendToken(ablock, text) {
  const parts = ablock.parts;
  let last = parts[parts.length - 1];
  if (!last || last.p !== "text" || !last.streaming) {
    last = { p: "text", text: "", streaming: true };
    parts.push(last);
    mountPart(ablock, last);
  }
  last.text += text;
  scheduleTextRender(last);
  scrollBottom();
}

function scheduleTextRender(part) {
  if (textTimers.has(part)) return;
  textTimers.set(part, setTimeout(() => {
    textTimers.delete(part);
    renderTextPart(part);
  }, 55));
}

function upsertToolCall(ablock, ev) {
  let part = [...ablock.parts].reverse().find((p) => p.p === "tool" && p.id === ev.id);
  if (!part) {
    part = { p: "tool", id: ev.id, name: ev.name || "", argsText: "", result: null };
    ablock.parts.push(part);
    mountPart(ablock, part);
  } else if (ev.name && !part.name) {
    part.name = ev.name;
    const refs = partEls.get(part);
    if (refs) {
      refs.el.querySelector(".tool-name").textContent = ev.name;
      refs.el.querySelector(".tool-icon").textContent = TOOL_ICONS[ev.name] || "🔧";
    }
  }
  part.argsText += ev.argsFragment || "";
  updateToolCard(part);
  scrollBottom();
}

function fillToolResult(ablock, ev) {
  const part = ablock.parts.find((p) => p.p === "tool" && p.id === ev.id) ||
    [...state.blocks[state.currentId] || []]
      .flatMap((b) => (b.t === "assistant" ? b.parts : []))
      .reverse().find((p) => p.p === "tool" && p.id === ev.id);
  if (!part) return;
  part.result = { content: ev.content, isError: Boolean(ev.isError) };
  updateToolCard(part);
  scrollBottom();
}

function addNodeChip(ablock, name) {
  const last = ablock.parts[ablock.parts.length - 1];
  if (last && last.p === "node" && last.name === name) return; // 相邻去重
  const part = { p: "node", name };
  ablock.parts.push(part);
  mountPart(ablock, part);
  scrollBottom();
}

function addApproval(ablock, payload) {
  const part = { p: "approval", req: payload, status: "pending" };
  ablock.parts.push(part);
  mountPart(ablock, part);
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = true;
  renderSessions();
  scrollBottom(true);
}

async function decideApproval(part, status) {
  if (state.streaming) return;
  part.status = status;
  const refs = partEls.get(part);
  if (refs) renderApprovalCard(part, refs.el);
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s) s.pendingApproval = false;
  renderSessions();
  saveLocal();
  await runResume(status === "approved" ? "approve" : "reject");
}

function addErrorBlock(ablock, message) {
  const block = { t: "error", text: message };
  transcript(state.currentId).push(block);
  mountBlock(block);
  scrollBottom(true);
}

/** finalize：结束流式态，清空光标 / 清理空块 */
function finalize(ablock) {
  if (ablock) {
    if (!ablock.parts.length) {
      // 整轮无输出（请求失败 / 立即中止）→ 移除空助手块
      if (ablock._el) ablock._el.remove();
      const arr = transcript(state.currentId);
      const i = arr.indexOf(ablock);
      if (i >= 0) arr.splice(i, 1);
    } else {
      for (const p of ablock.parts) {
        if (p.p === "text" && p.streaming) {
          p.streaming = false;
          renderTextPart(p);
        }
      }
    }
  }
  state.streaming = null;
  stopBtn.classList.add("hidden");
  sendBtn.classList.remove("hidden");
  sendBtn.disabled = !state.currentId;
  setStatus("idle");
  saveLocal();
}

function setStatus(mode) {
  const el = $("status-dot");
  el.className = "status " + mode;
}

/* ---------------------------------------------------------------------------
 * SSE 消费
 * ------------------------------------------------------------------------- */
async function consumeSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data: ")) {
          try { onEvent(JSON.parse(line.slice(6))); } catch { /* 忽略坏帧 */ }
        }
      }
    }
  }
}

function handleEvent(ev, ablock) {
  switch (ev.type) {
    case "token": appendToken(ablock, ev.text); break;
    case "tool_call": upsertToolCall(ablock, ev); break;
    case "tool_result": fillToolResult(ablock, ev); break;
    case "node": addNodeChip(ablock, ev.name); break;
    case "ai_message": {
      const last = ablock.parts[ablock.parts.length - 1];
      if (!last || last.p !== "text" || last.text !== ev.content) {
        const part = { p: "text", text: ev.content, streaming: true };
        ablock.parts.push(part);
        mountPart(ablock, part);
      }
      break;
    }
    case "interrupt": addApproval(ablock, ev.payload); break;
    case "usage": {
      // 上下文容量 ≈ 最近一次模型调用的 输入 + 输出；缓存占比 = cache_read / 输入
      const u = state.usage[state.currentId] || (state.usage[state.currentId] = {});
      u.lastInput = ev.inputTokens;
      u.lastOutput = ev.outputTokens;
      u.lastCache = ev.cacheReadTokens || 0;
      u.contextTokens = ev.inputTokens + ev.outputTokens;
      ablock._usage = { lastInput: ev.inputTokens, lastOutput: ev.outputTokens, lastCache: u.lastCache };
      updateTurnCaption(ablock);
      updateContextBar();
      saveLocal();
      break;
    }
    case "error": addErrorBlock(ablock, ev.message); break;
    case "done": break;
  }
}

/* ---------------------------------------------------------------------------
 * 发送 / 审批恢复 / 停止
 * ------------------------------------------------------------------------- */
async function send() {
  const text = inputEl.value.trim();
  if (!text || !state.currentId || state.streaming) return;
  const cur = state.sessions.find((x) => x.id === state.currentId);
  if (cur?.stale) return; // 历史会话不可发送
  // 附件引用：项目/远程文件传路径（服务端读取校验），上传传 uploadId
  const fileRefs = state.pendingFiles.map((f) => f.kind === "upload"
    ? { kind: "upload", uploadId: f.uploadId, name: f.name }
    : { kind: "fs", path: f.path, name: f.name });
  const filesMeta = state.pendingFiles.map((f) => ({
    name: f.name,
    source: f.preview ? "图片" : f.source,
    image: Boolean(f.preview),
  }));
  inputEl.value = "";
  autoGrow();

  const arr = transcript(state.currentId);
  const userBlock = { t: "user", text, ...(filesMeta.length ? { files: filesMeta } : {}) };
  const ablock = { t: "assistant", parts: [] };
  arr.push(userBlock, ablock);
  mountBlock(userBlock);
  mountBlock(ablock);
  saveLocal();
  state.pendingFiles = [];
  renderAttachChips();

  // 首条消息自动作为会话标题
  const s = state.sessions.find((x) => x.id === state.currentId);
  if (s && !s._renamed) {
    s.title = text.slice(0, 24) + (text.length > 24 ? "…" : "");
    s._renamed = true;
    $("session-title").textContent = s.title;
    renderSessions();
  }
  await streamTurn(`/api/chat`, {
    sessionId: state.currentId,
    message: text,
    ...(fileRefs.length ? { files: fileRefs } : {}),
  }, ablock);
}

async function runResume(decision) {
  if (!state.currentId || state.streaming) return;
  const ablock = { t: "assistant", parts: [] };
  transcript(state.currentId).push(ablock);
  mountBlock(ablock);
  await streamTurn(`/api/resume`, { sessionId: state.currentId, decision }, ablock);
}

async function streamTurn(url, body, ablock) {
  const ctrl = new AbortController();
  state.streaming = { ctrl, sid: state.currentId, ablock };
  stopBtn.classList.remove("hidden");
  sendBtn.classList.add("hidden");
  setStatus("busy");
  const wasNear = nearBottom();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    await consumeSSE(res, (ev) => handleEvent(ev, ablock));
  } catch (err) {
    if (err.name !== "AbortError") addErrorBlock(ablock, `请求失败：${err.message}`);
  } finally {
    finalize(ablock);
    if (wasNear) scrollBottom(true);
  }
}

function stopStreaming() {
  if (state.streaming) state.streaming.ctrl.abort();
}

/* ---------------------------------------------------------------------------
 * 滚动
 * ------------------------------------------------------------------------- */
function nearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 110;
}
function scrollBottom(force) {
  if (force || nearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
}

/* ---------------------------------------------------------------------------
 * 输入框
 * ------------------------------------------------------------------------- */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
  // 发送按钮随内容点亮：空输入保持灰态，有内容才变成主色渐变
  sendBtn.classList.toggle("is-ready", inputEl.value.trim().length > 0);
}

/* ---------------------------------------------------------------------------
 * 卡片与示例（新建对话弹窗 + 欢迎页共用）
 * ------------------------------------------------------------------------- */
function buildDemoCards(container) {
  container.innerHTML = "";

  // 通用 Agent（默认）：正常产品逻辑 —— 工具 + 文件上下文 + 多轮记忆 + 审批
  const agentCard = document.createElement("button");
  agentCard.className = "demo-card";
  agentCard.innerHTML = `
    <div class="d-head"><span class="d-num">⚡</span><span class="d-name">通用 Agent <span class="d-default">默认</span></span></div>
    <div class="d-desc">工具调用 · 📎 文件上下文 · 多轮记忆 · 高风险操作审批</div>
    <div class="d-eg">直接输入任何问题即可开始</div>`;
  agentCard.addEventListener("click", async () => {
    try { await createSession("agent", null, null); }
    catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
  });
  container.appendChild(agentCard);

  // 内置示例（学习 Demo）
  for (const d of state.config.demos) {
    const card = document.createElement("button");
    card.className = "demo-card";
    card.innerHTML = `
      <div class="d-head"><span class="d-num">${d.id}</span><span class="d-name"></span></div>
      <div class="d-desc"></div>
      <div class="d-eg"></div>`;
    card.querySelector(".d-name").textContent = d.name;
    card.querySelector(".d-desc").textContent = d.desc;
    card.querySelector(".d-eg").textContent = "示例：" + d.example;
    card.addEventListener("click", async () => {
      try {
        await createSession("demo", d.id, d.example);
      } catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
    });
    container.appendChild(card);
  }
}

function buildExampleChips() {
  const wrap = $("example-chips");
  wrap.innerHTML = "";
  for (const text of GENERAL_EXAMPLES) {
    const chip = document.createElement("button");
    chip.className = "ex-chip";
    chip.textContent = text;
    chip.addEventListener("click", async () => {
      try {
        await createSession("agent", null, text);
        await send();
      } catch (err) { uiAlert("创建对话失败：" + err.message, "创建对话"); }
    });
    wrap.appendChild(chip);
  }
}

function openModal() { $("modal-mask").classList.remove("hidden"); }
function closeModal() { $("modal-mask").classList.add("hidden"); }

/* ---------------------------------------------------------------------------
 * 设置（多供应商管理：添加 / 编辑 / 删除 / 切换）
 * ------------------------------------------------------------------------- */
let editingProviderId = null; // null = 新增模式，否则为正在编辑的供应商 id

/** 顶栏按钮 / 侧栏 / 徽章的统一刷新 */
function applyConfigState(cfg) {
  state.config = cfg;
  const mock = Boolean(cfg.mock);
  $("mode-badge").classList.toggle("hidden", !mock);
  const sideModel = $("side-model");
  sideModel.classList.toggle("mock", mock);
  $("side-model-text").textContent = mock ? `模拟模式 · ${cfg.model}` : cfg.model;
  const active = (cfg.providers || []).find((p) => p.active);
  const btnText = $("provider-btn-text");
  if (btnText) btnText.textContent = mock
    ? `模拟模式 · ${cfg.model}`
    : `${active?.modality === "vision" ? "🖼 " : ""}${active ? active.name + " · " : ""}${cfg.model}`;
  renderProviderMenu();
  updateContextBar();
  if (!$("settings-mask").classList.contains("hidden")) renderProviderList();
}

/* ---------------------------------------------------------------------------
 * 上下文容量条 + 缓存占比
 * 数据来源：模型响应里的 usage（input ≈ 当时整段对话的上下文，
 * input_token_details.cache_read ≈ 提示词缓存命中）；分母来自网关 /models
 * 返回的 context_length（未知时不显示占比，只显示 token 数）。
 * ------------------------------------------------------------------------- */
function fmtTokens(n) {
  if (n == null || isNaN(n)) return "–";
  if (n >= 100000) return Math.round(n / 1000) + "k";
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  return n.toLocaleString("zh-CN");
}

function updateContextBar() {
  const bar = $("context-bar");
  const u = state.usage[state.currentId];
  if (!u || !u.contextTokens) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");

  const win = state.config?.contextWindow || null;
  const fill = $("ctx-fill");
  if (win) {
    const pct = Math.min(100, (u.contextTokens / win) * 100);
    fill.style.width = Math.max(1.5, pct) + "%";
    fill.className = "ctx-fill" + (pct > 92 ? " danger" : pct > 80 ? " warn" : "");
    $("ctx-text").textContent = `上下文 ${fmtTokens(u.contextTokens)} / ${fmtTokens(win)} tokens（${pct.toFixed(1)}%）`;
  } else {
    fill.style.width = "0%";
    fill.className = "ctx-fill";
    $("ctx-text").textContent = `上下文 ${fmtTokens(u.contextTokens)} tokens · 容量未知（设置里「获取列表」后显示占比）`;
  }

  const cacheEl = $("ctx-cache");
  if (u.lastInput > 0 && u.lastCache > 0) {
    cacheEl.textContent = `缓存命中 ${Math.round((u.lastCache / u.lastInput) * 100)}%`;
    cacheEl.classList.remove("hidden");
  } else {
    cacheEl.classList.add("hidden");
  }
}

/** 助手回合末尾的用量小字：↑ 输入 · ↓ 输出 · 缓存 N% */
function updateTurnCaption(ablock) {
  const u = ablock._usage;
  if (!u) return;
  const body = blockBodies.get(ablock);
  if (!body) return;
  let el = usageEls.get(ablock);
  if (!el || !el.isConnected) {
    el = document.createElement("div");
    el.className = "usage-caption";
    body.appendChild(el);
    usageEls.set(ablock, el);
  }
  const cache = u.lastCache > 0 && u.lastInput > 0 ? ` · 缓存 ${Math.round((u.lastCache / u.lastInput) * 100)}%` : "";
  el.textContent = `↑ ${u.lastInput.toLocaleString("zh-CN")} · ↓ ${u.lastOutput.toLocaleString("zh-CN")}${cache}`;
}

/* ----- 顶栏快捷切换菜单 ----- */
function showProviderMenu(show) {
  $("provider-menu").classList.toggle("hidden", !show);
}

function renderProviderMenu() {
  const menu = $("provider-menu");
  menu.innerHTML = "";
  for (const p of state.config?.providers || []) {
    const b = document.createElement("button");
    b.className = "pm-item" + (p.active ? " active" : "");
    b.innerHTML = `<span class="pm-check">${p.active ? "✓" : ""}</span><span class="pm-name"></span><span class="pm-model"></span>`;
    b.querySelector(".pm-name").textContent = p.name;
    b.querySelector(".pm-model").textContent = p.model || "未设置模型";
    b.addEventListener("click", async () => {
      showProviderMenu(false);
      if (!p.active) await activateProvider(p.id);
    });
    menu.appendChild(b);
  }
  const divider = document.createElement("div");
  divider.className = "pm-divider";
  menu.appendChild(divider);
  const manage = document.createElement("button");
  manage.className = "pm-item pm-manage";
  manage.textContent = "⚙ 管理供应商（添加 / 编辑 / 删除）";
  manage.addEventListener("click", () => { showProviderMenu(false); openSettings(); });
  menu.appendChild(manage);
}

/* ----- 设置弹窗：供应商列表 ----- */
function openSettings() {
  showProviderMenu(false);
  api("/api/config").then(applyConfigState).catch(() => {});
  closeProviderForm();
  $("settings-mask").classList.remove("hidden");
}

function renderProviderList() {
  const list = $("provider-list");
  list.innerHTML = "";
  const providers = state.config?.providers || [];
  for (const p of providers) {
    const row = document.createElement("div");
    row.className = "provider-row" + (p.active ? " active" : "");
    row.innerHTML = `
      <div class="p-info">
        <div class="p-name"><span class="nm"></span><span class="p-badge ${p.hasKey ? "" : "nokey"}">${p.hasKey ? "✓ Key" : "无 Key"}</span>${p.modality === "vision" ? '<span class="p-badge vis">多模态</span>' : ""}${p.protocol && p.protocol !== "openai" ? `<span class="p-badge proto">${PROTOCOL_LABEL[p.protocol] || p.protocol}</span>` : ""}${p.active ? '<span class="p-badge">启用中</span>' : ""}</div>
        <div class="p-detail"></div>
      </div>
      <div class="p-actions">
        <button class="p-use ${p.active ? "in-use" : ""}">${p.active ? "使用中" : "启用"}</button>
        <button class="p-edit">编辑</button>
        ${providers.length > 1 ? '<button class="p-del">删除</button>' : ""}
      </div>`;
    row.querySelector(".nm").textContent = p.name;
    row.querySelector(".p-detail").textContent =
      `${p.baseURL} · ${p.model || "未设置模型"}` +
      (p.manualContextWindow ? ` · 窗口 ${fmtTokens(p.manualContextWindow)}` : "");
    if (!p.active) row.querySelector(".p-use").addEventListener("click", () => activateProvider(p.id));
    row.querySelector(".p-edit").addEventListener("click", () => openProviderForm(p.id));
    const del = row.querySelector(".p-del");
    if (del) del.addEventListener("click", () => removeProvider(p.id, p.name));
    list.appendChild(row);
  }
}

/* ----- 设置弹窗：编辑表单 ----- */
function openProviderForm(providerId) {
  editingProviderId = providerId || null;
  const p = editingProviderId
    ? (state.config.providers || []).find((x) => x.id === editingProviderId)
    : null;
  $("pf-mode").textContent = p ? p.name : "新增供应商";
  $("pf-mode").className = "key-state" + (p ? " ok" : "");
  $("pf-name").value = p?.name || "";
  $("pf-base-url").value = p?.baseURL || "";
  $("pf-api-key").value = "";
  $("pf-api-key").type = "password";
  $("pf-model").value = p?.model || "";
  $("pf-protocol").value = p?.protocol || "openai";
  $("pf-vision").checked = p ? p.modality === "vision" : false;
  $("pf-ctx").value = p?.manualContextWindow ?? "";
  $("pf-key-state").textContent = p ? (p.hasKey ? `已保存 ${p.keyMasked}，留空则不修改` : "未保存 Key") : "";
  $("pf-key-state").className = "key-state" + (p?.hasKey ? " ok" : "");
  $("model-list").innerHTML = "";
  setSettingsStatus("", "");
  $("provider-form-wrap").classList.remove("hidden");
  $("pf-name").focus();
}

function closeProviderForm() {
  editingProviderId = null;
  $("provider-form-wrap").classList.add("hidden");
}

function setSettingsStatus(text, kind) {
  const el = $("settings-status");
  el.textContent = text;
  el.className = "settings-status" + (kind ? " " + kind : "");
}

/** 测试连接：新供应商用表单值；编辑已存供应商且 Key 留空 → 用已保存的 Key 测 */
async function testConnection() {
  const baseURL = $("pf-base-url").value.trim();
  const apiKeyRaw = $("pf-api-key").value.trim();
  if (!baseURL) { setSettingsStatus("✗ 请先填写 BASE_URL", "err"); return; }
  const body = { baseURL };
  if (apiKeyRaw) body.apiKey = apiKeyRaw;
  else if (editingProviderId) body.providerId = editingProviderId;
  body.protocol = $("pf-protocol").value;

  setSettingsStatus("正在连接网关…", "");
  try {
    const res = await api("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      $("model-list").innerHTML = res.models.map((m) => `<option value="${m.replace(/"/g, "&quot;")}">`).join("");
      setSettingsStatus(`✓ 连接成功，网关支持 ${res.models.length} 个模型（模型输入框已可下拉选择）`, "ok");
      // 拉取成功会把 context_length 写入服务端缓存 → 刷新配置以更新容量条分母
      if (res.contextWindow) {
        api("/api/config").then(applyConfigState).catch(() => {});
      }
    } else {
      setSettingsStatus(`✗ ${res.error}`, "err");
    }
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

async function saveProvider() {
  const name = $("pf-name").value.trim();
  const baseURL = $("pf-base-url").value.trim();
  const model = $("pf-model").value.trim();
  const apiKeyRaw = $("pf-api-key").value.trim();
  if (!name) { setSettingsStatus("✗ 名称不能为空", "err"); return; }
  if (!baseURL) { setSettingsStatus("✗ BASE_URL 不能为空", "err"); return; }
  if (!model) { setSettingsStatus("✗ 模型名不能为空（可先「获取列表」再选）", "err"); return; }

  const body = {
    name,
    baseURL,
    model,
    protocol: $("pf-protocol").value,
    modality: $("pf-vision").checked ? "vision" : "text",
    contextWindow: $("pf-ctx").value.trim(), // 空串 = 清除手动上下文
  };
  if (apiKeyRaw) body.apiKey = apiKeyRaw; // 留空 = 不修改已保存的 Key

  try {
    if (editingProviderId) {
      const res = await api(`/api/config/providers/${editingProviderId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setSettingsStatus(res.activeChanged ? "✓ 已保存并应用到当前会话配置" : "✓ 已保存（该供应商未启用）", "ok");
      editingProviderId = null;
    } else {
      const res = await api("/api/config/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      editingProviderId = res.provider.id; // 保存后转为编辑态，便于继续调整
      setSettingsStatus(res.activeChanged ? "✓ 已添加并启用" : "✓ 已添加", "ok");
    }
    applyConfigState(await api("/api/config"));
    openProviderForm(editingProviderId); // 用保存后的状态刷新表单（Key 状态等）
    setSettingsStatus($("settings-status").textContent, "ok");
  } catch (err) {
    setSettingsStatus(`✗ ${err.message}`, "err");
  }
}

async function activateProvider(id) {
  try {
    const res = await api("/api/config/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    applyConfigState(await api("/api/config"));
    if (!$("settings-mask").classList.contains("hidden")) {
      setSettingsStatus(`✓ 已启用「${res.name}」· ${res.model}${res.mock ? "（无 Key → 模拟模式）" : ""}`, "ok");
    }
  } catch (err) {
    if (!$("settings-mask").classList.contains("hidden")) setSettingsStatus(`✗ ${err.message}`, "err");
    else uiAlert(`切换失败：${err.message}`, "切换供应商");
  }
}

async function removeProvider(id, name) {
  if (!(await uiConfirm(`确定删除供应商「${name}」？`, { title: "删除供应商", okText: "删除", danger: true }))) return;
  try {
    await api(`/api/config/providers/${id}`, { method: "DELETE" });
    applyConfigState(await api("/api/config"));
    if (editingProviderId === id) closeProviderForm();
  } catch (err) {
    uiAlert(`删除失败：${err.message}`, "删除供应商");
  }
}

/* ---------------------------------------------------------------------------
 * 文件上下文：项目文件 / 远程文件夹 / 本地上传
 * ------------------------------------------------------------------------- */
state.pendingFiles = []; // [{kind:"fs"|"upload", path?, uploadId?, name, source}]
let fsCwd = null;        // 当前浏览目录（null = 默认项目根）
let fsParent = null;     // 上一级目录（根目录时为 null）

function refKey(f) { return f.kind === "upload" ? `up:${f.uploadId}` : `fs:${f.path}`; }

function renderAttachChips() {
  const wrap = $("attach-chips");
  wrap.innerHTML = "";
  if (!state.pendingFiles.length) { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  for (const f of state.pendingFiles) {
    const chip = document.createElement("span");
    chip.className = "attach-chip" + (f.preview ? " has-thumb" : "");
    chip.innerHTML = `
      ${f.preview ? `<img class="thumb" alt="">` : "📎"}
      <span class="c-name"></span>
      <span class="c-src"></span>
      <button class="c-del" title="移除">✕</button>`;
    chip.querySelector(".c-name").textContent = f.name;
    chip.querySelector(".c-src").textContent = f.preview ? "图片" : f.source;
    if (f.preview) chip.querySelector(".thumb").src = f.preview;
    chip.querySelector(".c-del").addEventListener("click", () => {
      state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== refKey(f));
      renderAttachChips();
      renderFsSelection();
    });
    wrap.appendChild(chip);
  }
}

function addPendingFile(f) {
  if (state.pendingFiles.length >= 5) { uiAlert("单条消息最多附加 5 个文件", "附件数量超限"); return false; }
  if (state.pendingFiles.some((x) => refKey(x) === refKey(f))) return true; // 已选
  state.pendingFiles.push(f);
  renderAttachChips();
  renderFsSelection();
  return true;
}

function removePendingFile(key) {
  state.pendingFiles = state.pendingFiles.filter((x) => refKey(x) !== key);
  renderAttachChips();
  renderFsSelection();
}

/* ----- 文件选择器弹窗 ----- */
async function openFsModal() {
  if (!state.currentId) { uiAlert("请先选择或新建会话", "提示"); return; }
  $("fs-mask").classList.remove("hidden");
  await browseFs(null); // 回到默认项目根
}

function closeFsModal() { $("fs-mask").classList.add("hidden"); }

async function browseFs(path) {
  const list = $("fs-list");
  list.innerHTML = `<div class="fs-empty">加载中…</div>`;
  try {
    const data = await api("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    fsCwd = data.path;
    fsParent = data.parent;
    $("fs-path").textContent = data.path;
    $("fs-up").disabled = !data.parent;
    const rootSel = $("fs-root");
    rootSel.innerHTML = "";
    for (const r of data.roots) {
      const opt = document.createElement("option");
      opt.value = r.path;
      opt.textContent = `${r.type === "cloud" ? "☁️" : "💻"} ${r.name}`;
      rootSel.appendChild(opt);
    }
    // 位置下拉显示「最长匹配」的授权根（项目根是 work 的子目录，应优先显示项目根）
    const best = data.roots
      .filter((r) => data.path === r.path || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "/") || data.path.startsWith(r.path.replace(/[\\/]+$/, "") + "\\"))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (best) rootSel.value = best.path;
    renderFsRows(data.entries);
  } catch (err) {
    list.innerHTML = `<div class="fs-empty">✗ ${err.message}</div>`;
  }
}

function isFileSelected(ref) {
  return state.pendingFiles.some((x) => refKey(x) === refKey(ref));
}

function renderFsSelection() {
  const el = $("fs-selected");
  if (!el) return;
  el.textContent = state.pendingFiles.length
    ? `已选 ${state.pendingFiles.length} 个：${state.pendingFiles.map((f) => f.name).join("、")}`
    : "未选择文件（点击文件名勾选，再点「完成」加到输入框）";
  // 同步列表勾选标记
  document.querySelectorAll(".fs-row[data-key]").forEach((row) => {
    const selected = state.pendingFiles.some((x) => refKey(x) === row.dataset.key);
    row.classList.toggle("selected", selected);
    const check = row.querySelector(".f-check");
    if (check) check.textContent = selected ? "✓" : "";
  });
}

function renderFsRows(entries) {
  const list = $("fs-list");
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="fs-empty">（空文件夹）</div>`;
    return;
  }
  for (const e of entries) {
    const row = document.createElement("button");
    const ref = { kind: "fs", path: (fsCwd ? fsCwd.replace(/[\\/]+$/, "") + "/" : "") + e.name, name: e.name };
    row.className = "fs-row" + (e.type === "dir" ? " dir" : "");
    if (e.type === "file") {
      row.dataset.key = refKey(ref);
      if (isFileSelected(ref)) row.classList.add("selected");
    }
    row.innerHTML = `<span class="f-icon">${e.type === "dir" ? "📁" : "📄"}</span><span class="f-name"></span><span class="f-check"></span><span class="f-size"></span>`;
    row.querySelector(".f-name").textContent = e.name;
    row.querySelector(".f-size").textContent = e.type === "file" ? fmtSize(e.size) : "";
    row.addEventListener("click", () => {
      if (e.type === "dir") browseFs(ref.path);
      else {
        if (isFileSelected(ref)) removePendingFile(refKey(ref));
        else addPendingFile(ref);
      }
    });
    list.appendChild(row);
  }
}

function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

async function openRemoteFolder() {
  const p = await uiPrompt(
    "输入服务器上的文件夹绝对路径（例如 E:\\study 或 /home/user/project）：\n⚠ 这会把该目录暴露给网页端浏览，仅建议在本地/可信环境使用",
    { title: "打开远程文件夹", placeholder: "E:\\study 或 /home/user/project" }
  );
  if (!p || !p.trim()) return;
  try {
    const res = await api("/api/fs/open-remote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    await browseFs(res.path);
  } catch (err) {
    uiAlert("打开失败：" + err.message, "打开远程文件夹");
  }
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

async function uploadLocalFiles(fileList) {
  for (const file of fileList) {
    const isImage = file.type.startsWith("image/");
    if (isImage && file.size > 4_500_000) { uiAlert(`「${file.name}」图片过大（>4.5MB）`, "文件过大"); continue; }
    if (!isImage && file.size > 800_000) { uiAlert(`「${file.name}」过大（>800KB），请压缩或拆分`, "文件过大"); continue; }
    try {
      let content, image = false, preview = null;
      if (isImage) {
        content = await readAsDataURL(file); // dataURL：多模态模型可直接消费
        image = true;
        preview = content;
      } else {
        content = await file.text();
      }
      const res = await api("/api/files/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, content, image }),
      });
      addPendingFile({
        kind: "upload", uploadId: res.id, name: res.name,
        source: isImage ? "图片" : "本地上传", preview,
      });
    } catch (err) {
      uiAlert(`「${file.name}」上传失败：${err.message}`, "上传失败");
    }
  }
}

/* ---------------------------------------------------------------------------
 * 拖拽上传 —— 不依赖系统文件选择框。
 * 场景：以自动化参数启动的浏览器（如 --disable-blink-features=AutomationControlled）
 * 会静默屏蔽 <input type=file> 的系统选择框，但 drop 事件通道不受影响。
 * ------------------------------------------------------------------------- */
let dragDepth = 0;

function setupDragDrop() {
  // 全页拖放浮层
  const overlay = document.createElement("div");
  overlay.id = "drop-overlay";
  overlay.className = "hidden";
  overlay.innerHTML = `<div class="drop-box">📎 松开鼠标，把文件附加到当前对话</div>`;
  document.body.appendChild(overlay);

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");
  const finish = () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.classList.add("hidden"); };

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    dragDepth += 1;
    overlay.classList.remove("hidden");
  });
  document.addEventListener("dragleave", () => { if (dragDepth) finish(); });
  document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    e.preventDefault(); // 阻止浏览器直接打开文件
    dragDepth = 0;
    overlay.classList.add("hidden");
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    uploadLocalFiles(files);
  });

  // 文件选择器弹窗内拖拽高亮
  const modal = $("fs-modal");
  if (modal) {
    modal.addEventListener("dragover", (e) => { e.preventDefault(); modal.classList.add("dragover"); });
    modal.addEventListener("dragleave", () => modal.classList.remove("dragover"));
    modal.addEventListener("drop", () => modal.classList.remove("dragover"));
  }
}

/* ---------------------------------------------------------------------------
 * 启动
 * ------------------------------------------------------------------------- */
async function init() {
  loadLocal();

  // 配置
  try {
    state.config = await api("/api/config");
  } catch (err) {
    uiAlert("无法连接服务：" + err.message, "连接失败");
    return;
  }
  applyConfigState(state.config);
  const footNote = $("side-foot-note");
  if (footNote) footNote.textContent = `点击模型名可修改配置 · ${APP_VERSION.replace(/^web-\d{4}-/, "v")}`;
  await loadProjects();
  await loadExternalAgents();

  // 能力自检：前端具备但服务端缺失的接口 → 说明服务进程是旧代码启动的，提示重启。
  // （静态文件每次请求都读磁盘，浏览器能拿到新脚本；但路由是进程启动时固化的）
  try {
    const probe = await fetch("/api/fs/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (probe.status === 404) {
      showFatalBanner(
        "服务端版本过旧：缺少文件接口（/api/fs/list 返回 404）。\n" +
        "请完全停止当前的 npm run web 进程后重新运行，再刷新本页面。"
      );
    }
  } catch { /* 网络问题另有报错 */ }

  // 会话列表：服务端（内存态）+ 本地元数据（标题覆盖 / 重启后残留标记失效）
  let serverSessions = [];
  try { serverSessions = await api("/api/sessions"); } catch { /* 服务刚重启等 */ }
  const localMetas = JSON.parse(localStorage.getItem(LS_SESSIONS) || "[]");
  const localById = new Map(localMetas.map((m) => [m.id, m]));
  state.sessions = serverSessions.map((s) => ({
    ...s,
    stale: false,
    title: localById.get(s.id)?.title || s.title,
  }));
  // 本地有、服务端没有 → 说明服务重启过，标记为「仅可查看历史」
  const serverIds = new Set(serverSessions.map((s) => s.id));
  const stale = localMetas
    .filter((m) => !serverIds.has(m.id))
    .map((m) => ({
      id: m.id, stale: true, title: m.title || "历史会话",
      kind: m.kind || (m.demo ? "demo" : "agent"), demo: m.demo || null,
      createdAt: m.createdAt || 0, pendingApproval: false,
    }));
  state.sessions.push(...stale);

  buildDemoCards($("demo-cards"));
  buildDemoCards($("modal-cards"));
  buildExampleChips();

  // 事件绑定（on()：元素缺失时告警但不中断，避免单个弹窗缺失拖垮全部交互）
  const on = (id, event, fn) => {
    const el = $(id);
    if (el) el.addEventListener(event, fn);
    else console.warn("[init] 未找到元素 #" + id + "，已跳过绑定");
  };

  on("new-chat-btn", "click", () => { setSidebarOpen(false); openModal(); });
  on("add-external-btn", "click", addExternalFlow);
  on("modal-close", "click", closeModal);
  on("modal-mask", "click", (e) => { if (e.target === $("modal-mask")) closeModal(); });

  // 主题：顶栏 ☀️/🌙 切换 + 持久化
  updateThemeBtn();
  on("theme-btn", "click", toggleTheme);

  // 窄屏抽屉侧栏：☰ 开关 / 遮罩关闭 / Esc 关闭
  on("sidebar-toggle", "click", () => setSidebarOpen(!$("sidebar").classList.contains("open")));
  on("sidebar-scrim", "click", () => setSidebarOpen(false));

  // 供应商：设置弹窗 + 顶栏切换器
  const closeSettings = () => { $("settings-mask").classList.add("hidden"); closeProviderForm(); };
  on("settings-btn", "click", openSettings);
  on("side-model", "click", openSettings);
  on("provider-btn", "click", (e) => {
    e.stopPropagation();
    const menu = $("provider-menu");
    api("/api/config").then(applyConfigState).catch(() => {});
    showProviderMenu(menu.classList.contains("hidden"));
  });
  document.addEventListener("click", (e) => {
    const sw = document.querySelector(".provider-switch");
    if (!sw || !sw.contains(e.target)) showProviderMenu(false);
    const pw = document.querySelector(".project-switch");
    if (!pw || !pw.contains(e.target)) showProjectMenu(false);
  });

  // 项目文件夹：切换 / 添加（本地 / 云端）
  on("project-btn", "click", async (e) => {
    e.stopPropagation();
    const menu = $("project-menu");
    await loadProjects();
    showProjectMenu(menu.classList.contains("hidden"));
  });
  on("settings-mask", "click", (e) => { if (e.target === $("settings-mask")) closeSettings(); });
  on("add-provider-btn", "click", () => openProviderForm(null));
  on("pf-cancel-edit", "click", closeProviderForm);
  on("pf-key-toggle", "click", () => {
    const keyInput = $("pf-api-key");
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });
  on("pf-fetch-models", "click", testConnection);
  on("pf-test", "click", testConnection);
  on("pf-save", "click", saveProvider);

  // 文件上下文：📎 附件 / 文件选择器 / 远程文件夹 / 本地上传
  on("attach-btn", "click", openFsModal);
  on("fs-done", "click", closeFsModal);
  on("fs-mask", "click", (e) => { if (e.target === $("fs-mask")) closeFsModal(); });
  on("fs-up", "click", () => { if (fsParent) browseFs(fsParent); });
  on("fs-root", "change", (e) => browseFs(e.target.value));
  on("fs-remote", "click", openRemoteFolder);
  on("fs-upload-btn", "click", () => {
    // 显式触发文件输入：比 label 转发更可靠（所有浏览器在用户手势里都会弹系统选择框）
    $("fs-upload-input").click();
  });
  on("fs-upload-help", "click", () => {
    uiAlert(
      "「上传本地文件」依赖浏览器的系统文件选择框。如果点击后没有任何反应：\n\n" +
      "1. 把文件从资源管理器直接拖拽到本窗口 —— 推荐走这条通道（拖拽不依赖系统选择框）\n" +
      "2. 截图/复制的文件可直接 Ctrl+V 粘贴到输入框附加\n" +
      "3. 本机环境因素也会拦截选择框：企业策略浏览器、安全软件外壳扩展、" +
      "自动化参数启动（页面顶部黄条有 --disable-blink-features 提示即属于此）\n" +
      "4. 可在其他网站（如网页邮箱的添加附件）测试选择框是否同样失效，以确定是本机环境问题",
      "上传没反应？"
    );
  });
  on("fs-upload-input", "change", (e) => {
    if (e.target.files?.length) uploadLocalFiles([...e.target.files]);
    e.target.value = "";
  });
  setupDragDrop();

  on("send-btn", "click", send);
  on("stop-btn", "click", stopStreaming);
  inputEl.addEventListener("input", autoGrow);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // 粘贴上传：剪贴板里是文件（如截图、复制的文件）时直接作为附件，纯文本走默认输入
  inputEl.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    if (!state.currentId) { uiAlert("请先选择或新建会话，再附加文件", "提示"); return; }
    uploadLocalFiles(files);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      uiDialogFinish(null); // 兜底：焦点不在弹窗内时也能 Esc 关闭（未打开时是 no-op）
      closeModal();
      closeSettings();
      closeFsModal();
      showProviderMenu(false);
      setSidebarOpen(false);
    }
    if (e.key === "Enter" && ["pf-name", "pf-base-url", "pf-api-key", "pf-model"].includes(e.target.id)) {
      e.preventDefault();
      saveProvider();
    }
  });

  renderSessions();
  if (state.sessions.length) selectSession(state.sessions[0].id);
  else showWelcomeState();
}

// 入口兜底：init 抛错时在页面上直接可见（否则所有按钮都静默失效）
init().catch((err) => {
  console.error("[init] 初始化失败：", err);
  showFatalBanner("初始化失败：" + (err && err.stack ? err.stack : err));
});
