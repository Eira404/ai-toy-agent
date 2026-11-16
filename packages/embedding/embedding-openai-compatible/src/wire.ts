import { EmbeddingError } from "toy-embedding"

/** 解析后的单条嵌入条目，携带 Provider 返回的原始 index。 */
export interface ParsedEmbeddingItem {
  readonly index: number
  readonly vector: readonly number[]
}

/** 一次 /embeddings 响应的解析结果，条目已按 index 升序排列。 */
export interface ParsedEmbeddings {
  readonly items: readonly ParsedEmbeddingItem[]
  readonly modelId: string
  readonly dimensions: number
}

/** 构造 /embeddings 请求体。 */
export function serializeRequest(
  model: string,
  texts: readonly string[],
  dimensions?: number,
): Record<string, unknown> {
  return {
    model,
    input: [...texts],
    ...(dimensions === undefined ? {} : { dimensions }),
  }
}

/** 解析 /embeddings 响应，校验结构并返回按 index 排序的向量。 */
export function parseEmbeddings(payload: unknown): ParsedEmbeddings {
  if (!isPlainRecord(payload)) {
    throw new EmbeddingError("Provider 响应不是对象", "INVALID_RESPONSE")
  }
  if (!Array.isArray(payload.data)) {
    throw new EmbeddingError("Provider 响应缺少 data 数组", "INVALID_RESPONSE")
  }

  const items: ParsedEmbeddingItem[] = []
  for (const raw of payload.data) {
    if (!isPlainRecord(raw)) {
      throw new EmbeddingError("嵌入条目不是对象", "INVALID_RESPONSE")
    }
    if (!Number.isInteger(raw.index) || (raw.index as number) < 0) {
      throw new EmbeddingError("嵌入条目 index 无效", "INVALID_RESPONSE")
    }
    if (!Array.isArray(raw.embedding)) {
      throw new EmbeddingError("嵌入向量必须是数组", "INVALID_RESPONSE")
    }
    const vector = raw.embedding as number[]
    if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new EmbeddingError("嵌入向量必须是有限数值数组", "INVALID_RESPONSE")
    }
    items.push({ index: raw.index as number, vector })
  }
  items.sort((left, right) => left.index - right.index)

  let dimensions = 0
  for (const item of items) {
    if (dimensions === 0) {
      dimensions = item.vector.length
    } else if (item.vector.length !== dimensions) {
      throw new EmbeddingError("嵌入向量维度不一致", "INVALID_RESPONSE")
    }
  }

  const modelId = typeof payload.model === "string" ? payload.model : ""
  return { items, modelId, dimensions }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
