/**
 * tools.ts — 自定义工具（Tool / Function Calling）
 *
 * LangGraph 里「工具」就是给 LLM 调用的函数，需要用 zod 声明参数 schema，
 * 模型才能知道工具叫什么、要传什么参数。这里定义 4 个工具：
 *
 *   calculator      四则运算计算器    —— 演示纯函数工具
 *   get_current_time 当前时间          —— 演示无参数工具
 *   get_weather     天气查询（模拟）   —— 演示带枚举参数
 *   send_email      发送邮件（模拟）   —— 演示「高风险操作」，在 Demo 3 中需要人工审批
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. 计算器：白名单正则校验后求值，安全且无需依赖第三方库
// ---------------------------------------------------------------------------
const SAFE_EXPRESSION = /^[\d+\-*/().\s]+$/;

export const calculator = tool(
  async ({ expression }) => {
    if (!SAFE_EXPRESSION.test(expression)) {
      return "表达式包含非法字符，只支持数字和 + - * / ( ) 运算符。";
    }
    // 已经通过白名单校验（不含字母/分号等），再用 Function 求值，无注入风险
    const value = new Function(`"use strict"; return (${expression});`)();
    return `计算结果：${expression} = ${value}`;
  },
  {
    name: "calculator",
    description: "计算数学表达式，支持 + - * / 和括号，例如 (1+2)*3。",
    schema: z.object({
      expression: z.string().describe("要计算的数学表达式，如 (1+2)*3"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 2. 当前时间：无参数工具
// ---------------------------------------------------------------------------
export const getCurrentTime = tool(
  async () => {
    return `当前时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  },
  {
    name: "get_current_time",
    description: "获取当前日期和时间。当用户问「现在几点 / 今天几号」时调用。",
    schema: z.object({}), // 空 schema 表示该工具不需要任何参数
  }
);

// ---------------------------------------------------------------------------
// 3. 天气查询：模拟实现（真实项目可替换为和风天气 / OpenWeatherMap 等 API）
// ---------------------------------------------------------------------------
const WEATHER_TABLE: Record<string, { temp: number; desc: string }> = {
  北京: { temp: 26, desc: "晴转多云" },
  上海: { temp: 30, desc: "多云有阵雨" },
  广州: { temp: 33, desc: "雷阵雨" },
  深圳: { temp: 31, desc: "多云" },
  成都: { temp: 24, desc: "阴天" },
};

export const getWeather = tool(
  async ({ city }) => {
    const data = WEATHER_TABLE[city];
    if (!data) {
      return `没有「${city}」的天气数据，目前支持：${Object.keys(WEATHER_TABLE).join("、")}。`;
    }
    return `「${city}」当前 ${data.temp}°C，${data.desc}。`;
  },
  {
    name: "get_weather",
    description: "查询指定城市的当前天气（模拟数据）。",
    schema: z.object({
      city: z.string().describe("城市名，如 北京"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 4. 发送邮件：模拟高风险操作
//    在 Demo 3（human-in-the-loop）中，执行前会暂停并请求人工审批
// ---------------------------------------------------------------------------
export const sendEmail = tool(
  async ({ to, subject, body }) => {
    // 模拟发送：真实项目这里调用邮件服务 API
    return `✅ 邮件已发送：收件人 ${to}，主题「${subject}」。\n内容：${body}`;
  },
  {
    name: "send_email",
    description:
      "向指定收件人发送一封邮件。收到发邮件请求时直接调用即可，是否发送由系统在调用前人工审批，无需先向用户确认。",
    schema: z.object({
      to: z.string().describe("收件人邮箱地址"),
      subject: z.string().describe("邮件主题"),
      body: z.string().describe("邮件正文"),
    }),
  }
);

// ---------------------------------------------------------------------------
// 工具清单：Demo 1 / 2 / 3 共用；Demo 3 还单独演示了手动执行工具
// ---------------------------------------------------------------------------
export const demoTools = [calculator, getCurrentTime, getWeather, sendEmail];

/** name -> 工具 的映射，方便在代码里按名字查找并执行（Demo 3 用到） */
export const toolsByName = Object.fromEntries(
  demoTools.map((t) => [t.name, t])
) as Record<string, (typeof demoTools)[number]>;
