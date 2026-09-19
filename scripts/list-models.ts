/**
 * ============================================================
 * list-models.ts — 查看「自定义 OpenAI 兼容网关」支持的模型列表
 * ============================================================
 * 之前踩过的坑：.env 里写了一个网关不支持的模型名（如 gpt-4o-mini），
 * 调用时网关直接返回 HTTP 400 且无响应体，非常难排查。
 * 这个脚本就是排查工具 —— 先看网关到底支持哪些模型，再写 .env。
 *
 * 运行：npm run models
 */
import "dotenv/config";
import { config } from "../src/config.js";

interface GatewayModel {
  id: string;
  context_length?: number;
  supports_tools?: boolean;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
  effective_input_price_per_million?: number | null;
  effective_output_price_per_million?: number | null;
}

// Node 22+ 自带 fetch，无需额外依赖
const res = await fetch(`${config.baseURL.replace(/\/+$/, "")}/models`, {
  headers: { Authorization: `Bearer ${config.apiKey}` },
});

if (!res.ok) {
  console.error(
    `[models] 请求失败 HTTP ${res.status}（无响应体时通常是路径或鉴权问题）\n` +
      `  地址: ${config.baseURL}/models`
  );
  process.exit(1);
}

const body = (await res.json()) as { data?: GatewayModel[] };

if (!body.data?.length) {
  console.error("[models] 网关没有返回任何模型");
  process.exit(1);
}

console.log(`网关 ${config.baseURL} 支持的模型（${body.data.length} 个）：\n`);
for (const m of body.data) {
  const price =
    m.effective_input_price_per_million != null && m.effective_output_price_per_million != null
      ? ` ¥${m.effective_input_price_per_million}/${m.effective_output_price_per_million}每百万token`
      : "";
  console.log(
    `  - ${m.id}` +
      (m.context_length ? `  context=${m.context_length}` : "") +
      (m.supports_tools ? "  tools=✓" : "") +
      (m.supports_reasoning ? "  reasoning=✓" : "") +
      (m.supports_vision ? "  vision=✓" : "") +
      price
  );
}

console.log(
  `\n当前 .env 配置的模型: ${config.model}` +
    (body.data.some((m) => m.id === config.model)
      ? "  ✅ 可用"
      : "  ❌ 不在列表中！请改成上面任意一个 id")
);

console.log(
  "\n提示：网关返回的模型可以一次性都加进 Web 设置页 —— npm run web → 右上角 ⚙ 设置 →\n" +
    "      选中供应商 → 「获取列表」→ 点一下模型 chip 即添加（一个供应商可挂多个模型）；\n" +
    "      顶栏 ▾ 按供应商分组列出全部模型，点一行切换，菜单顶部可调「思考等级」。"
);
