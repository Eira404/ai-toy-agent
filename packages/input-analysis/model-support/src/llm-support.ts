import { Service, type Context } from "cordis"
import type { LlmMessage, LlmRuntime } from "toy-llm"
import { z } from "zod"

export interface LlmSupportConfig {
  /** 模型路由名；本包不提供默认值，必须由调用方配置。 */
  readonly provider?: string
  /** 模型名；本包不提供默认值，必须由调用方配置。 */
  readonly model?: string
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface LlmSupportModelConfig {
  readonly provider: string
  readonly model: string
  readonly temperature: number
  readonly maxTokens: number
}

export interface LlmSupportHistoryMessage {
  readonly role: "assistant" | "user"
  readonly content: string
}

export interface LlmSupportInvocation<TOutput> {
  readonly schema: z.ZodType<TOutput>
  readonly systemMessage: string
  readonly userMessage: string
  readonly history?: readonly LlmSupportHistoryMessage[]
  readonly signal?: AbortSignal
}

/**
 * 需要 LLM 的业务 Service 可继承此类，复用模型配置与结构化调用能力。
 * 领域输入校验、Prompt 和输出 Schema 仍由子类负责。
 */
export abstract class LlmSupport<TInput, TOutput> extends Service {
  static inject = ["llm"]

  private readonly supportModel: LlmSupportModel

  constructor(ctx: Context, name: string, config: LlmSupportConfig = {}) {
    super(ctx, name)
    const provider = config.provider?.trim()
    const model = config.model?.trim()
    if (
      provider === undefined ||
      provider.length === 0 ||
      model === undefined ||
      model.length === 0
    ) {
      throw new TypeError(`${name} 需要 config 提供 provider 和 model`)
    }
    this.supportModel = new LlmSupportModel(name, ctx.llm, {
      provider,
      model,
      temperature: config.temperature ?? 0,
      maxTokens: config.maxTokens ?? 128,
    })
  }

  abstract analyze(input: TInput, signal?: AbortSignal): Promise<TOutput>

  protected _analyze(options: LlmSupportInvocation<TOutput>): Promise<TOutput> {
    return this.supportModel.invoke(options)
  }
}

/** 统一完成 LLM JSON Schema 调用、文本提取与 Zod 二次校验。 */
export class LlmSupportModel {
  private readonly schemaName: string

  constructor(
    private readonly name: string,
    private readonly llm: LlmRuntime,
    private readonly config: LlmSupportModelConfig,
  ) {
    this.schemaName = normalizeSchemaName(name)
    if (!Number.isFinite(config.temperature) || config.temperature < 0) {
      throw new TypeError(`${name} temperature 必须是非负有限数字`)
    }
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0) {
      throw new TypeError(`${name} maxTokens 必须是正整数`)
    }
  }

  async invoke<TOutput>(options: LlmSupportInvocation<TOutput>): Promise<TOutput> {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: [{ type: "text", text: options.systemMessage }],
      },
      ...(options.history ?? []).map((message) => ({
        role: message.role,
        content: [{ type: "text" as const, text: message.content }],
      })),
      {
        role: "user",
        content: [{ type: "text", text: options.userMessage }],
      },
    ]
    const generated = await this.llm.generate({
      provider: this.config.provider,
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      reasoning: { enabled: false },
      responseFormat: {
        type: "json_schema",
        name: this.schemaName,
        schema: toProviderJsonSchema(options.schema),
        strict: true,
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    if (generated.finish.kind === "error" || generated.finish.kind === "aborted") {
      throw new Error(
        `${this.name} 模型调用失败 [${generated.finish.failure.code}]：${generated.finish.failure.message}`,
      )
    }

    const text = generated.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
    const parsed = options.schema.safeParse(extractJson(text, this.name))
    if (!parsed.success) {
      throw new Error(`${this.name} 模型响应格式无效：${z.prettifyError(parsed.error)}`)
    }
    return parsed.data
  }
}

/** 移除 Provider 不需要的 JSON Schema dialect 标记。 */
function toProviderJsonSchema<TOutput>(
  schema: z.ZodType<TOutput>,
): Readonly<Record<string, unknown>> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema)
  return jsonSchema
}

function normalizeSchemaName(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64)
  if (normalized.length === 0) {
    throw new TypeError("LLM Schema 名称不能为空")
  }
  return normalized
}

function extractJson(text: string, name: string): unknown {
  const trimmed = text.trim()
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) {
    throw new Error(`${name} 模型没有返回 JSON：${trimmed.slice(0, 300)}`)
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch (error) {
    throw new Error(`${name} 模型返回的 JSON 无效：${trimmed.slice(0, 300)}`, { cause: error })
  }
}
