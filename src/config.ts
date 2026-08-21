/**
 * config.ts — 统一读取 .env 中的网关配置
 *
 * 为什么要单独抽一个文件？
 * 所有 demo 共用一个「自定义 OpenAI 兼容网关」，把 baseURL / apiKey / model
 * 集中在这里管理，方便你在不修改任何 agent 代码的情况下切换供应商或模型。
 */
import "dotenv/config";

export const config = {
  /** 兼容 OpenAI 格式的 API 地址（例如 https://tokenrhythm.studio/v1） */
  baseURL: process.env.BASE_URL ?? "https://tokenrhythm.studio/v1",

  /** API Key */
  apiKey: process.env.API_KEY ?? "",

  /** 模型名。运行 `npm run models` 可查看网关支持的模型列表 */
  model: process.env.MODEL ?? "gpt-4o-mini",
} as const;

/** 启动前校验配置是否齐全，缺 Key 时给出明确提示并退出 */
export function assertConfig(): void {
  if (!config.apiKey) {
    console.error(
      "[config] 缺少 API_KEY。\n" +
        "  请复制 .env.example 为 .env 并填入你的 API Key，或设置环境变量 API_KEY。"
    );
    process.exit(1);
  }
  if (!config.baseURL) {
    console.error("[config] 缺少 BASE_URL（OpenAI 兼容网关地址）。");
    process.exit(1);
  }
  console.log(
    `[config] 网关: ${config.baseURL}  模型: ${config.model}\n`
  );
}
