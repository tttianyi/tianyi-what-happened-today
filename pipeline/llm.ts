// LLM 抽象层 / LLM abstraction layer
// pipeline 只依赖 LLMClient 接口，不直接依赖 Groq。以后换 Claude 等，只需新增一个实现类。
// The pipeline depends only on the LLMClient interface, not on Groq directly.
// Switching provider later (e.g. Claude) = add another class; nothing else changes.
import Groq from "groq-sdk";
import { z } from "zod";

export interface LLMClient {
  readonly name: string;
  /**
   * 让 LLM 按 schema 返回 JSON，并在运行时用 zod 校验。
   * Ask the LLM for JSON matching `schema`, validated at runtime with zod.
   */
  generateJson<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<{ data: T; tokens: number }>;
}

export class GroqClient implements LLMClient {
  readonly name: string;
  private client: Groq;

  /**
   * reasoningEffort：推理模型"想多少"。简单任务用 low（快、省 token），写作类任务用 medium。
   * reasoningEffort: how much a reasoning model thinks. "low" for easy tasks (fast, fewer tokens), "medium" for writing.
   */
  constructor(
    private model: string,
    private reasoningEffort: "none" | "default" | "low" | "medium" | "high" = "low",
  ) {
    this.name = `groq:${model}`;
    // 自动读取环境变量 GROQ_API_KEY / Reads GROQ_API_KEY from the environment.
    // SDK 自带重试：遇到 429（限流）和 5xx 会按 retry-after 等待后重试。默认 2 次，免费版限流较紧，调到 5 次。
    // The SDK retries 429 (rate limit) and 5xx itself, honouring retry-after.
    // Default is 2; the free tier is tight, so we allow 5.
    this.client = new Groq({ maxRetries: 5 });
  }

  async generateJson<T>(req: { system: string; user: string; schema: z.ZodType<T>; schemaName: string }) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      // 结构化输出（strict）：模型只能生成符合 schema 的 JSON
      // Structured output (strict): the model can only emit JSON matching the schema
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, strict: true, schema: z.toJSONSchema(req.schema) },
      },
      reasoning_effort: this.reasoningEffort,
    });

    const text = res.choices[0]?.message.content ?? "";
    // 即使用了 strict 模式也再校验一次：不信任任何外部输入，包括 LLM 的输出
    // Validate anyway, even in strict mode: never trust external input, LLM output included
    const data = req.schema.parse(JSON.parse(text));
    return { data, tokens: res.usage?.total_tokens ?? 0 };
  }
}
