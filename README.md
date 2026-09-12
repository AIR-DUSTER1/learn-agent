# LangGraph Agent 工作台

一个用 **LangGraph.js**（TypeScript）搭建的**可正常使用的 Agent Web 应用**：
多轮对话、📎 文件上下文（项目文件 / 远程文件夹 / 本地上传）、多供应商模型切换、
上下文用量与缓存监控、高风险操作人工审批 —— 与正常 Agent 产品的使用逻辑一致。

项目同时内置 **4 个学习示例**（基础 ReAct / 对话记忆 / 人工审批 / 多 Agent 协作），
作为「事例选择」保留在新建对话与欢迎页里：默认走通用 Agent，
想观察某个特定图结构的运行方式时再选对应示例。每个示例文件都带详细中文注释。

> 📖 **完整学习文档见 [`docs/agent-wiki.md`](docs/agent-wiki.md)** —— 核心概念讲解、
> 模块功能详解、示例的调用链分析（含实测日志）、从零自建 Agent 模板。

## 快速开始

```bash
npm install
cp .env.example .env        # 填入你的 BASE_URL / API_KEY / MODEL
npm run models              # 先确认网关支持哪些模型（防止 400 报错）
npm run web                 # 启动 Web 界面 → http://localhost:3000
```

> 💡 **没有 API Key？** 也能跑：未配置 `API_KEY` 时自动进入**模拟模式** ——
> 模型决策由本地脚本编排，但工具调用、流式输出、人工审批等交互全部真实可玩。
> 也可以不建 `.env`，启动后在网页右上角 **⚙ 设置** 里添加供应商并填入 Key。

## Web 界面（参考 ZCode）

```bash
npm run web                 # http://localhost:3000（PORT 环境变量可改端口）
```

- **左侧会话栏**：多会话管理，每个会话绑定一个 Demo（图实例 + thread_id）；
- **流式回答**：token 级打字机输出 + Markdown 渲染（表格 / 代码块 / 引用）；
- **工具调用卡片**：参数随模型生成逐字流出，完成后展示结果，可展开查看（同 ZCode 的工具块）；
- **节点徽章**：`🧠 agent` / `🔧 tools` / `👔 supervisor` / `🔍 researcher/agent`，
  图的执行轨迹一目了然；
- **项目文件夹（本地 / 云端）**：侧栏「项目 ▾」可选项目，会话按项目分组显示；
  项目分两类并用样式区分 —— **💻 本地**（服务器上的目录）与
  **☁️ 云端**（Git 仓库地址，添加时自动 `git clone --depth 1` 到本地缓存，
  支持一键 `git pull` 刷新，删除时清理缓存）；新建对话归属当前项目；
- **文件上下文（📎）**：给消息附加文件，三种来源 ——
  **项目文件**（浏览项目目录树勾选，位置下拉带 💻/☁️ 标记）、
  **远程文件夹**（授权服务器上的任意目录）、
  **本地上传 / 拖拽 / 粘贴**（支持文本文件与**图片**，服务部署在云端时从本机选择）；
  发送时服务端读取内容（授权校验 + 防路径穿越 + 超长截断）拼进消息，
  模型直接基于文件内容回答；
- **图片与多模态**：粘贴 / 拖拽 / 上传的图片以缩略 chip 展示，发送时转为
  `image_url` 内容块进入消息 —— 仅当启用中的模型勾选了「多模态」；
  纯文本模型附加图片会得到明确提示；
- **上下文容量与缓存占比**：输入框上方实时显示 `上下文 1.7k / 131k（1.3%）` 容量条
  与绿色 `缓存命中 62%`，每个助手回合末尾还有 `↑ 输入 · ↓ 输出 · 缓存 N%` 小字 ——
  数据来自模型响应的 `usage`（含提示词缓存命中），分母来自模型上下文窗口：
  可在设置里**手动输入**，留空则自动读取网关 `/models` 的 `context_length`；
- **人工审批（Demo 3）**：发送邮件前弹出审批卡，批准/拒绝按钮对应 `Command({ resume })`；
- **停止按钮**：随时中断生成（AbortSignal 直通模型请求）。

### 在界面里管理供应商与模型（多供应商）

点右上角 **⚙ 设置**（或顶栏的供应商按钮 ▾ / 侧栏底部的模型名），无需改 `.env`、无需重启：

- **多供应商**：可添加任意多个供应商档案（名称 + 网关地址 + API Key + 模型），
  列表中一键「启用」切换，顶栏 **▾** 也有快捷切换菜单；
- **网关地址 BASE_URL**：任意 OpenAI 兼容网关（中转站 / vLLM / 官方 API）；
- **API Key**：密文显示、只回传掩码；编辑时留空表示保持不变，清空保存可回到模拟模式；
- **模型 MODEL**：可点「获取列表 / 测试连接」从网关拉取可用模型下拉选择
  （编辑已保存的供应商时 Key 留空，会用已存的 Key 去测）；

- 「测试连接」会实际请求 `{BASE_URL}/models`，Key 错误 / 路径不对会直接显示原因；
- 切换后**新建会话立即生效**；已有会话在下一条消息时自动切换模型
  （Demo 2/3 的多轮记忆会重置，等同重启服务）；
- 至少保留一个供应商；删除启用中的供应商会自动切到列表第一个；
- 配置持久化在本地 `.web-config.json`（已 gitignore，含 Key），优先级高于 `.env`，
  删除该文件即回退到 `.env`；旧版单供应商格式会自动迁移。

架构：`node:http` + SSE（无 Express）｜前端原生 HTML/CSS/JS（无框架、无构建）。
事件协议与翻译层见 `src/server/events.ts` / `stream.ts`，细节见 Wiki §3.11。

### 接入第三方 Agent（只需要一个 Git 地址）

「＋ 新建对话」弹窗底部有 **🔌 外部 Agent** 区块：粘贴任意 Git 仓库地址 → 服务端
`git clone --depth 1` 到 `.setting/agents/` → 自动识别启动方式 → 注册为可选择的会话类型。
例如 DeepSeek 的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)、
任何带 CLI 入口的 agent 工具仓库，都可以这样接入。

识别优先级：**① 仓库根 `agent.json` 清单（推荐约定）→ ② package.json 的 bin / main 字段
（Node 类工具）→ ③ 常见入口文件（cli.js / index.js / agent.py / main.py …）**。
都没有也没关系，接入时会让你补一条启动命令。

`agent.json` 清单格式（放在你的仓库根，本工作台和第三方都能照此提供）：

```json
{
  "name": "my-agent",
  "description": "一句话介绍",
  "command": "node",
  "args": ["cli.js", "--prompt", "{{prompt}}"],
  "passCredentials": false
}
```

- `{{prompt}}` 占位符会替换成用户消息；没有占位符时，消息以一行 JSON
  `{"message":"…"}` 从 stdin 传入；
- 启动命令的 **stdout** 按块流式转发到聊天界面，非 0 退出展示 stderr 尾部；
- 每条消息 = 启动一次子进程（180s 超时），外部工具自己管理上下文；
- `passCredentials: true` 时才把当前启用供应商的网关配置注入子进程环境
  （`AGENT_API_KEY` / `AGENT_BASE_URL` / `AGENT_MODEL` 及 `OPENAI_*` 同名变量），
  默认不传 —— 谨慎对可信仓库开启；
- 接入 = 在服务器上运行第三方代码，请只添加可信仓库。
- 支持 `https://` / `git@` / `file:///`（本地测试用）地址。

## 内置示例（4 个学习 Demo）

新建对话时可选「通用 Agent」（默认）或以下示例 —— 每个示例是一张刻意保持教学形态的图，
用来观察特定结构的运行方式：

| # | 文件 | 学习重点 | 运行 |
|---|------|---------|------|
| 1 | `src/agent/basic.ts` | **基础 ReAct Agent**：State / Node / Edge / 条件边 / 工具循环 | `npm run demo:1` |
| 2 | `src/agent/memory.ts` | **对话记忆**：Checkpointer 检查点 + thread_id 多轮记忆 | `npm run demo:2` |
| 3 | `src/agent/hitl.ts` | **Human-in-the-loop**：interrupt() 暂停 + 人工审批高风险操作 | `npm run demo:3` |
| 4 | `src/agent/multi.ts` | **多 Agent 协作**：Supervisor 主管 + 员工子图分派任务 | `npm run demo:4` |

> 通用 Agent 的定义在 `src/agent/general.ts` —— 它就是把示例 1/2/3 的能力
> （工具循环 + 记忆 + 审批）按产品逻辑组合后的形态。CLI（`npm run demo:1~4`）
> 保留用于命令行学习。

## 项目结构

```
src/
  config.ts      # 统一读取 .env（baseURL / apiKey / model），切换供应商不改业务代码
  llm.ts         # ChatOpenAI 工厂：configuration.baseURL 接入任意 OpenAI 兼容网关
  tools.ts       # 4 个自定义工具（calculator / 时间 / 天气 / 发邮件），zod 声明参数
  agent/
    general.ts   # 通用 Agent（默认）：工具循环 + 记忆 + 审批的产品化组合
    basic.ts     # 示例 1：亲手搭一张 ReAct 图（不借助 prebuilt 的 createAgent）
    memory.ts    # 示例 2：compile({ checkpointer }) 获得多轮记忆
    hitl.ts      # 示例 3：interrupt()/Command.resume 实现人工审批
    multi.ts     # 示例 4：子图当节点，主管用虚拟工具 delegate 路由
  cli.ts         # CLI 入口：streamMode:"updates" 逐节点打印，让流程可视化
  server/        # Web 界面（参考 ZCode）：SSE 服务 + 原生前端，见「Web 界面」
scripts/
  list-models.ts # npm run models：查询网关支持的模型列表（排查 400 的利器）
```

## 踩坑记录（排查 400）

网关返回 **HTTP 400 且无响应体**，最常见原因是 **模型名不在网关支持列表里**
（例如 `gpt-4o-mini` 并非所有中转站都有）。排查三步：

1. `npm run models` 查看网关实际支持的模型列表；
2. 把 `.env` 里的 `MODEL` 改成列表里的 id（如 `deepseek-v4-flash`）；
3. 重跑 demo。

`.env` 里的真实配置在本地，已通过 `.gitignore` 排除，不会提交。

## 学习路线建议

1. 先跑 **Demo 1**，把 `src/agent/basic.ts` 的注释和图结构对照着看，
   理解「节点 = 处理步骤，边 = 执行顺序，状态 = 节点间传递的数据」；
2. 再跑 **Demo 2**，体会同一张图加上 checkpointer 之后的行为差异；
3. **Demo 3** 演示了 Agent 落地必学的「人工把关」能力（发邮件/付款前审批）；
4. 最后看 **Demo 4**，理解如何用子图把多个 agent 组合成团队。
