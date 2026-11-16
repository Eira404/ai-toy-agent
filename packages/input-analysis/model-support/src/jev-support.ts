import { Service, type Context } from "cordis"
import type { Jev, JevQuestions, JevResponse } from "toy-jev"
import type { ZodType } from "zod"

export interface JevSupportConfig {
  readonly provider?: string
}

export interface JevSupportModelConfig {
  readonly provider?: string
}

interface JevInvocation<TOutput> {
  readonly state: string
  readonly name: string
  readonly instructions: string
  readonly schema: ZodType<TOutput>
  readonly signal?: AbortSignal
}

export interface JevChoiceInvocation<TOutput> extends JevInvocation<TOutput> {
  readonly criteria: Record<string, string>
}

export interface JevScoreInvocation<TOutput> extends JevInvocation<TOutput> {
  readonly criteria: string[]
}

export type JevNoulInvocation<TOutput> = JevInvocation<TOutput>

/**
 * 需要 JEV 的业务 Service 可继承此类，直接取得经过领域 Schema 校验的结果。
 * state、问题定义和输出 Schema 仍由子类负责。
 */
export abstract class JevSupport<TInput, TOutput> extends Service {
  static inject = ["jev"]

  private readonly supportModel: JevSupportModel

  constructor(ctx: Context, name: string, config: JevSupportConfig = {}) {
    super(ctx, name)
    this.supportModel = new JevSupportModel(ctx.jev, {
      ...(config.provider?.trim() ? { provider: config.provider.trim() } : {}),
    })
  }

  abstract analyze(input: TInput, signal?: AbortSignal): Promise<TOutput>

  protected invokeJevChoice(options: JevChoiceInvocation<TOutput>): Promise<TOutput> {
    return this.supportModel.invokeChoice(options)
  }

  protected invokeJevScore(options: JevScoreInvocation<TOutput>): Promise<TOutput> {
    return this.supportModel.invokeScore(options)
  }

  protected invokeJevNoul(options: JevNoulInvocation<TOutput>): Promise<TOutput> {
    return this.supportModel.invokeNoul(options)
  }

  protected invokeJevRaw(
    state: string,
    questions: JevQuestions,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    return this.supportModel.invokeRaw(state, questions, signal)
  }
}

/** 把 JEV 协议响应投影成业务可直接使用的扁平结果。 */
export class JevSupportModel {
  constructor(
    private readonly jev: Jev,
    private readonly config: JevSupportModelConfig,
  ) {}

  async invokeChoice<TOutput>(options: JevChoiceInvocation<TOutput>): Promise<TOutput> {
    const response = await this.invokeRaw(
      options.state,
      {
        [options.name]: {
          type: "choice",
          instructions: options.instructions,
          criteria: options.criteria,
        },
      },
      options.signal,
    )
    const answer = response.answers[options.name]
    if (answer?.type !== "choice") {
      throw new Error(`JEV 没有返回 choice 类型的 '${options.name}' 答案`)
    }
    return options.schema.parse({
      [options.name]: answer.choice,
      confidence: answer.confidence,
    })
  }

  async invokeScore<TOutput>(options: JevScoreInvocation<TOutput>): Promise<TOutput> {
    const response = await this.invokeRaw(
      options.state,
      {
        [options.name]: {
          type: "score",
          instructions: options.instructions,
          criteria: options.criteria,
        },
      },
      options.signal,
    )
    const answer = response.answers[options.name]
    if (answer?.type !== "score") {
      throw new Error(`JEV 没有返回 score 类型的 '${options.name}' 答案`)
    }
    return options.schema.parse({
      [options.name]: answer.score,
      confidence: answer.confidence,
    })
  }

  async invokeNoul<TOutput>(options: JevNoulInvocation<TOutput>): Promise<TOutput> {
    const response = await this.invokeRaw(
      options.state,
      {
        [options.name]: {
          type: "noul",
          instructions: options.instructions,
        },
      },
      options.signal,
    )
    const answer = response.answers[options.name]
    if (answer?.type !== "noul") {
      throw new Error(`JEV 没有返回 noul 类型的 '${options.name}' 答案`)
    }
    return options.schema.parse({ [options.name]: answer.noul })
  }

  /** 多问题或非标准映射场景仍可显式访问原始 JEV 响应。 */
  invokeRaw(state: string, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
    return this.jev.invoke(state, questions, {
      ...(this.config.provider === undefined ? {} : { provider: this.config.provider }),
      ...(signal === undefined ? {} : { signal }),
    })
  }
}
