import { Service, type Context } from "cordis"
import "toy-memory-fast"
import "toy-llm"
import type { FastDraft } from "toy-memory-fast"
import {
  resolveFastExtractConfig,
  type FastExtractConfig,
  type ResolvedFastExtractConfig,
} from "./config.js"
import { FastWriteError } from "./error.js"
import { buildUserMessage, FAST_EXTRACT_SYSTEM_MESSAGE } from "./prompts.js"
import { FastExtractionOutputSchema, fastExtractionJsonSchema } from "./schema.js"
import type {
  ConversationItem,
  ExtractWait,
  FastExtractInput,
  FastExtractResult,
  FastWriteInput,
  FastWriteResult,
  Scope,
} from "./types.js"

declare module "cordis" {
  interface Context {
    memoryWrite: FastWrite
  }
}

/** 冻结后的提取输入快照（重试期间不重新读取）。 */
interface PreparedExtract {
  readonly scope: Scope
  readonly sessionId: string
  readonly turnId: string
  readonly userMessage: string
  readonly conversation: readonly ConversationItem[]
  readonly signal: AbortSignal | undefined
}

/** 提取循环的中间结果。 */
type ExtractOutcome =
  | { readonly kind: "drafts"; readonly drafts: readonly FastDraft[]; readonly attempts: number }
  | { readonly kind: "failed"; readonly attempts: number; readonly error: string }

/**
 * 对话期 Fast 写入服务。
 *
 * 两个入口：
 * - `extract`：把用户原话经 LLM 提取成 0..N 条草稿并落库，`wait` 控制返回时机；
 * - `write`：直接写入调用方提供的 title/summary/body，绕过 LLM。
 *
 * 依赖 `toy-memory-fast`（`listRecentBySession` + `append`）与 `toy-llm`（结构化提取）。
 */
export class FastWrite extends Service {
  static inject = ["memoryFast", "llm"]

  private readonly config: ResolvedFastExtractConfig

  /** @param config 装配配置；`llmProvider` 与 `llmModel` 必填。 */
  constructor(ctx: Context, config: FastExtractConfig) {
    super(ctx, "memoryWrite")
    this.config = resolveFastExtractConfig(config)
  }

  /**
   * 提取并写入：读取同 Session 最近 Fast 与近期对话，调用 LLM 产出记忆草稿，
   * 校验后 `append` 落库。失败按配置重试一次。
   *
   * @param input 当前用户原话与近期对话。
   * @param wait `started` 启动即返回（后台继续落库）；`written`（默认）保证落库。
   */
  async extract(input: FastExtractInput, wait: ExtractWait = "written"): Promise<FastExtractResult> {
    const prepared = this.prepareExtract(input)

    if (wait === "started") {
      void this.runExtractPipeline(prepared).catch((error: unknown) => {
        console.warn("[toy-memory-write] 后台提取失败", error)
      })
      return { kind: "started" }
    }

    return this.runExtractPipeline(prepared)
  }

  /**
   * 直接写入 title/summary/body（绕过 LLM），立即落库。
   *
   * 幂等与字段长度校验由 `toy-memory-fast.append` 保证。
   *
   * @param input 范围、来源 Session/Turn 与草稿。
   */
  async write(input: FastWriteInput): Promise<FastWriteResult> {
    assertWriteInput(input)
    const result = await this.ctx.memoryFast.append({
      scope: input.scope,
      sessionId: input.sessionId,
      turnId: input.turnId,
      drafts: input.drafts,
    })
    return { kind: "written", writeId: result.writeId, records: result.records }
  }

  /** 校验输入并冻结近期对话快照。 */
  private prepareExtract(input: FastExtractInput): PreparedExtract {
    assertScope(input.scope)
    assertNonEmpty(input.sessionId, "sessionId")
    assertNonEmpty(input.turnId, "turnId")
    assertNonEmpty(input.userMessage, "userMessage")
    return {
      scope: input.scope,
      sessionId: input.sessionId,
      turnId: input.turnId,
      userMessage: input.userMessage,
      conversation: input.recentConversation.slice(0, this.config.recentConversationLimit),
      signal: input.signal,
    }
  }

  /** 完整提取流水线：读最近 Fast → 提取（重试）→ 空/失败则提前返回 → 落库。 */
  private async runExtractPipeline(prepared: PreparedExtract): Promise<FastExtractResult> {
    const recentFast = await this.ctx.memoryFast.listRecentBySession(
      prepared.scope,
      prepared.sessionId,
      this.config.recentSessionFastLimit,
    )

    const userText = buildUserMessage(prepared.userMessage, prepared.conversation, recentFast)
    const outcome = await this.extractWithRetry(userText, prepared.signal)

    if (outcome.kind === "failed") {
      return { kind: "failed", attempts: outcome.attempts, error: outcome.error }
    }
    if (outcome.drafts.length === 0) {
      return { kind: "empty", attempts: outcome.attempts }
    }

    const result = await this.ctx.memoryFast.append({
      scope: prepared.scope,
      sessionId: prepared.sessionId,
      turnId: prepared.turnId,
      drafts: outcome.drafts,
    })
    return { kind: "written", writeId: result.writeId, records: result.records, attempts: outcome.attempts }
  }

  /** 提取循环：同一冻结 prompt 重试，耗尽返回 failed。 */
  private async extractWithRetry(userText: string, signal: AbortSignal | undefined): Promise<ExtractOutcome> {
    let lastError = "未知错误"
    for (let attempts = 1; attempts <= this.config.maxAttempts; attempts += 1) {
      try {
        signal?.throwIfAborted()
        const drafts = await this.extractOnce(userText, signal)
        return { kind: "drafts", drafts, attempts }
      } catch (error) {
        lastError = String(error instanceof Error ? error.message : error).slice(0, 2000)
      }
    }
    return { kind: "failed", attempts: this.config.maxAttempts, error: lastError }
  }

  /** 单次提取：调用 LLM → 取文本 → JSON 解析 → zod 校验 → 程序校验。 */
  private async extractOnce(userText: string, signal: AbortSignal | undefined): Promise<readonly FastDraft[]> {
    const result = await this.ctx.llm.generate({
      provider: this.config.llmProvider,
      model: this.config.llmModel,
      messages: [
        { role: "system", content: [{ type: "text", text: FAST_EXTRACT_SYSTEM_MESSAGE }] },
        { role: "user", content: [{ type: "text", text: userText }] },
      ],
      responseFormat: {
        type: "json_schema",
        name: "fast_extraction",
        schema: fastExtractionJsonSchema,
      },
      ...(this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens }),
      ...(signal === undefined ? {} : { signal }),
    })

    let text = ""
    for (const block of result.content) {
      if (block.type === "text") {
        text += block.text
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new FastWriteError("invalid-input", "LLM 输出不是合法 JSON", { cause: error })
    }

    const validated = FastExtractionOutputSchema.parse(parsed)

    if (validated.memories.length > this.config.maxMemoriesPerTurn) {
      throw new FastWriteError(
        "invalid-input",
        `单轮输出 ${validated.memories.length} 条超过上限 ${this.config.maxMemoriesPerTurn}`,
      )
    }
    for (const draft of validated.memories) {
      assertBodyListFormat(draft.body)
    }

    return validated.memories.map((draft) => ({
      title: draft.title,
      summary: draft.summary,
      body: draft.body,
    }))
  }
}

export default FastWrite

// ---------------------------------------------------------------------------
// 输入校验（模块级纯函数，不对外导出）
// ---------------------------------------------------------------------------

function assertScope(scope: Scope): void {
  assertNonEmpty(scope.userId, "scope.userId")
  assertNonEmpty(scope.memorySpaceId, "scope.memorySpaceId")
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new FastWriteError("invalid-input", `${name} 必须是非空字符串`)
  }
}

function assertWriteInput(input: FastWriteInput): void {
  assertScope(input.scope)
  assertNonEmpty(input.sessionId, "sessionId")
  assertNonEmpty(input.turnId, "turnId")
  if (input.drafts.length === 0) {
    throw new FastWriteError("invalid-input", "drafts 不能为空")
  }
}

/** 校验 body 每行都是 `- ` 开头的无序列表项。 */
function assertBodyListFormat(body: string): void {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) {
    throw new FastWriteError("invalid-input", "body 至少需要一行无序列表项")
  }
  for (const line of lines) {
    if (!line.startsWith("- ")) {
      throw new FastWriteError("invalid-input", "body 每行必须是以 '- ' 开头的无序列表项")
    }
  }
}
