# LangGraph.js Agent 学习 Demo

用 **LangGraph.js**（TypeScript + CLI）从零搭建 Agent 流程的学习项目。
5 个 Demo 由浅入深，覆盖 Agent 开发的核心概念，每个文件都带详细中文注释。

> 📖 **完整学习文档见 [`docs/agent-wiki.md`](docs/agent-wiki.md)** —— 核心概念讲解、
> 模块功能详解、各 Demo 的调用链分析（含实测日志）、使用方法、从零自建 Agent 模板。

## 快速开始

```bash
npm install
cp .env.example .env        # 填入你的 BASE_URL / API_KEY / MODEL
npm run models              # 先确认网关支持哪些模型（防止 400 报错）
npm run demo:1              # 跑第一个 Demo
```

## 5 个 Demo 一览

| # | 文件 | 学习重点 | 运行 |
|---|------|---------|------|
| 1 | `src/agent/basic.ts` | **基础 ReAct Agent**：State / Node / Edge / 条件边 / 工具循环 | `npm run demo:1` |
| 2 | `src/agent/memory.ts` | **对话记忆**：Checkpointer 检查点 + thread_id 多轮记忆 | `npm run demo:2` |
| 3 | `src/agent/hitl.ts` | **Human-in-the-loop**：interrupt() 暂停 + 人工审批高风险操作 | `npm run demo:3` |
| 4 | `src/agent/multi.ts` | **多 Agent 协作**：Supervisor 主管 + 员工子图分派任务 | `npm run demo:4` |
| 5 | `src/agent/parallel.ts` | **并行 map-reduce**：Send API 动态分发 + 自定义 State/reducer | `npm run demo:5` |

> 不带参数运行 `npm run start` 会弹出选择菜单；也可传自定义问题，
> 例如 `npx tsx src/cli.ts 1 "帮我算一下 (5+3)*2"`、`npx tsx src/cli.ts 5 "咖啡, 露营, 极光"`。
> Demo 1~4 带 **token 级流式输出**：思考过程（灰色）+ 回答逐字打出。

## 项目结构

```
src/
  config.ts      # 统一读取 .env（baseURL / apiKey / model），切换供应商不改业务代码
  llm.ts         # ChatOpenAI 工厂：configuration.baseURL 接入任意 OpenAI 兼容网关
  tools.ts       # 4 个自定义工具（calculator / 时间 / 天气 / 发邮件），zod 声明参数
  agent/
    basic.ts     # Demo 1：亲手搭一张 ReAct 图（不借助 prebuilt 的 createAgent）
    memory.ts    # Demo 2：compile({ checkpointer }) 获得多轮记忆
    hitl.ts      # Demo 3：interrupt()/Command.resume 实现人工审批
    multi.ts     # Demo 4：子图当节点，主管用虚拟工具 delegate 路由
    parallel.ts  # Demo 5：Send API 并行 map-reduce + Annotation.Root 自定义状态
  cli.ts         # 统一入口：token 流式 + 节点日志 + 审批交互
scripts/
  list-models.ts # npm run models：查询网关支持的模型列表（排查 400 的利器）
docs/
  agent-wiki.md  # 完整学习 Wiki（概念/模块/调用链/模板）
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
