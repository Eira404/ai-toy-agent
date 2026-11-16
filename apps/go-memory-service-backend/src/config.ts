import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseYaml } from "./yaml.js"

/** LLM adapter：`type` 决定装配哪个插件，`name`（map 键）即注册的 provider 名。 */
export interface LlmAdapterConfig {
  readonly type: "openai-responses"
  readonly baseURL: string
  readonly apiKey?: string
}

/** Embedding adapter：`type` 决定装配哪个插件，`name`（map 键）即注册的 provider 名。 */
export interface EmbeddingAdapterConfig {
  readonly type: "openai-compatible"
  readonly baseURL: string
  readonly apiKey?: string
}

/**
 * JEV adapter：`type` 决定装配哪个插件，`name`（map 键）即注册的 provider 名。
 *
 * - `typesafe`：TypeSafe HTTP 服务（连接信息，不含 model）。
 * - `llm`：桥接到 LLM（`JevLlmPlugin`），`llmProvider` 指向 llm 段的 chain 或 adapter。
 *
 * model 一律由链条目（或单 adapter 调用的 invoke options）提供，不在 adapter 配置里。
 */
export type JevAdapterConfig =
  | { readonly type: "typesafe"; readonly baseURL: string; readonly apiKey: string }
  | {
      readonly type: "llm"
      readonly llmProvider: string
      readonly temperature?: number
      readonly maxTokens?: number
    }

/** JEV 降级链候选：provider 指向 adapter 名，model 为该候选使用的模型（必填）。 */
export interface JevChainEntry {
  readonly provider: string
  readonly model: string
}

/** LLM / Embedding 降级链候选：provider 指向 adapter 名，model 为该候选使用的模型。 */
export interface ModelChainEntry {
  readonly provider: string
  readonly model: string
}

export interface AppConfig {
  readonly storage: { readonly databaseUrl: string; readonly schema?: string }
  readonly http: { readonly host: string; readonly port: number }
  readonly llm: {
    readonly adapters: Record<string, LlmAdapterConfig>
    readonly chains: Record<string, readonly ModelChainEntry[]>
  }
  readonly embedding: {
    readonly dimensions: number
    readonly adapters: Record<string, EmbeddingAdapterConfig>
    readonly chains: Record<string, readonly ModelChainEntry[]>
  }
  readonly jev: {
    readonly adapters: Record<string, JevAdapterConfig>
    readonly chains: Record<string, readonly JevChainEntry[]>
  }
  readonly memory: {
    readonly extract: { readonly llm: string }
    readonly daily: { readonly llm: string; readonly jev: string; readonly embedding: string }
    readonly embedding: string
    readonly scheduler: { readonly dailyAt?: string; readonly timeZone: string; readonly minPendingFast: number }
  }
}

/**
 * 读取并解析配置：定位 YAML → 解析 → `${ENV}` / `${ENV:-默认}` 插值 → 校验成类型化对象。
 *
 * 文件路径默认取本包根目录下的 `config.yaml`，可用 `CONFIG_FILE` 环境变量覆盖。
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const file = env.CONFIG_FILE ?? fileURLToPath(new URL("../config.yaml", import.meta.url))
  const raw = parseYaml(readFileSync(file, "utf8"))
  return validateConfig(interpolate(raw, env))
}

/** 递归把字符串里的 `${VAR}` / `${VAR:-default}` 替换为环境变量值。 */
function interpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_all, name, def) => {
      const found = env[name]
      if (found !== undefined && found !== "") {
        return found
      }
      return def === undefined ? "" : def
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolate(item, env))
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = interpolate(item, env)
    }
    return out
  }
  return value
}

function validateConfig(tree: unknown): AppConfig {
  const root = asObject(tree, "root")
  const storage = asObject(root.storage, "storage")
  const http = asObject(root.http, "http")
  const llm = asObject(root.llm, "llm")
  const embedding = asObject(root.embedding, "embedding")
  const jev = asObject(root.jev, "jev")
  const memory = asObject(root.memory, "memory")
  const extract = asObject(memory.extract, "memory.extract")
  const daily = asObject(memory.daily, "memory.daily")
  const scheduler = asObject(memory.scheduler, "memory.scheduler")

  const databaseUrl = asString(storage.databaseUrl, "storage.databaseUrl")
  const schema = optionalString(storage.schema)

  const host = asString(http.host, "http.host")
  const port = asInt(http.port, "http.port")

  const llmAdapters = parseLlmAdapters(asObject(llm.adapters, "llm.adapters"))
  const llmChains = parseModelChains(asObject(llm.chains, "llm.chains"), "llm.chains")
  const embeddingAdapters = parseEmbeddingAdapters(asObject(embedding.adapters, "embedding.adapters"))
  const embeddingChains = parseModelChains(asObject(embedding.chains, "embedding.chains"), "embedding.chains")
  const dimensions = asInt(embedding.dimensions, "embedding.dimensions")
  const jevAdapters = parseJevAdapters(asObject(jev.adapters, "jev.adapters"))
  const jevChains = parseJevChains(asObject(jev.chains, "jev.chains"))

  const extractLlm = asString(extract.llm, "memory.extract.llm")
  const dailyLlm = asString(daily.llm, "memory.daily.llm")
  const dailyJev = asString(daily.jev, "memory.daily.jev")
  const dailyEmbedding = asString(daily.embedding, "memory.daily.embedding")
  const memoryEmbedding = asString(memory.embedding, "memory.embedding")
  const dailyAt = optionalString(scheduler.dailyAt)
  const timeZone = asString(scheduler.timeZone, "memory.scheduler.timeZone")
  const minPendingFast = asInt(scheduler.minPendingFast, "memory.scheduler.minPendingFast")

  // 引用完整性：memory.* 指向的链必须存在（JEV 无 adapter 时允许不校验）。
  requireChain(llmChains, extractLlm, "memory.extract.llm")
  requireChain(llmChains, dailyLlm, "memory.daily.llm")
  requireChain(embeddingChains, dailyEmbedding, "memory.daily.embedding")
  requireChain(embeddingChains, memoryEmbedding, "memory.embedding")
  if (Object.keys(jevAdapters).length > 0) {
    requireChain(jevChains, dailyJev, "memory.daily.jev")
  }

  // JEV 的 llm 桥接必须指向 llm 段已声明的 chain 或 adapter。
  for (const [name, adapter] of Object.entries(jevAdapters)) {
    if (adapter.type !== "llm") {
      continue
    }
    const isChain = adapter.llmProvider in llmChains
    const isAdapter = adapter.llmProvider in llmAdapters
    if (!isChain && !isAdapter) {
      throw new Error(`配置 jev.adapters.${name}.llmProvider 引用了不存在的 LLM 路由 '${adapter.llmProvider}'`)
    }
  }

  return {
    storage: { databaseUrl, ...(schema === undefined ? {} : { schema }) },
    http: { host, port },
    llm: { adapters: llmAdapters, chains: llmChains },
    embedding: { dimensions, adapters: embeddingAdapters, chains: embeddingChains },
    jev: { adapters: jevAdapters, chains: jevChains },
    memory: {
      extract: { llm: extractLlm },
      daily: { llm: dailyLlm, jev: dailyJev, embedding: dailyEmbedding },
      embedding: memoryEmbedding,
      scheduler: { ...(dailyAt === undefined ? {} : { dailyAt }), timeZone, minPendingFast },
    },
  }
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`配置 ${name} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`配置 ${name} 必须是非空字符串`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function asInt(value: unknown, name: string): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`配置 ${name} 必须是整数`)
  }
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isSafeInteger(n)) {
    throw new Error(`配置 ${name} 必须是整数`)
  }
  return n
}

function asNumber(value: unknown, name: string): number {
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`配置 ${name} 必须是数字`)
  }
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(`配置 ${name} 必须是有限数字`)
  }
  return n
}

function parseLlmAdapters(value: Record<string, unknown>): Record<string, LlmAdapterConfig> {
  const out: Record<string, LlmAdapterConfig> = {}
  for (const [name, raw] of Object.entries(value)) {
    const a = asObject(raw, `llm.adapters.${name}`)
    const type = asString(a.type, `llm.adapters.${name}.type`)
    if (type !== "openai-responses") {
      throw new Error(`不支持的 llm adapter 类型 '${type}'`)
    }
    const baseURL = asString(a.baseURL, `llm.adapters.${name}.baseURL`)
    const apiKey = optionalString(a.apiKey)
    out[name] = { type, baseURL, ...(apiKey === undefined ? {} : { apiKey }) }
  }
  return out
}

function parseEmbeddingAdapters(value: Record<string, unknown>): Record<string, EmbeddingAdapterConfig> {
  const out: Record<string, EmbeddingAdapterConfig> = {}
  for (const [name, raw] of Object.entries(value)) {
    const a = asObject(raw, `embedding.adapters.${name}`)
    const type = asString(a.type, `embedding.adapters.${name}.type`)
    if (type !== "openai-compatible") {
      throw new Error(`不支持的 embedding adapter 类型 '${type}'`)
    }
    const baseURL = asString(a.baseURL, `embedding.adapters.${name}.baseURL`)
    const apiKey = optionalString(a.apiKey)
    out[name] = { type, baseURL, ...(apiKey === undefined ? {} : { apiKey }) }
  }
  return out
}

function parseJevAdapters(value: Record<string, unknown>): Record<string, JevAdapterConfig> {
  const out: Record<string, JevAdapterConfig> = {}
  for (const [name, raw] of Object.entries(value)) {
    const a = asObject(raw, `jev.adapters.${name}`)
    const type = asString(a.type, `jev.adapters.${name}.type`)
    if (type === "typesafe") {
      out[name] = {
        type,
        baseURL: asString(a.baseURL, `jev.adapters.${name}.baseURL`),
        apiKey: asString(a.apiKey, `jev.adapters.${name}.apiKey`),
      }
      continue
    }
    if (type === "llm") {
      const llmProvider = asString(a.llmProvider, `jev.adapters.${name}.llmProvider`)
      const temperature =
        a.temperature === undefined ? undefined : asNumber(a.temperature, `jev.adapters.${name}.temperature`)
      const maxTokens =
        a.maxTokens === undefined ? undefined : asInt(a.maxTokens, `jev.adapters.${name}.maxTokens`)
      out[name] = {
        type,
        llmProvider,
        ...(temperature === undefined ? {} : { temperature }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }
      continue
    }
    throw new Error(`不支持的 jev adapter 类型 '${type}'`)
  }
  return out
}

function parseModelChains(
  value: Record<string, unknown>,
  label: string,
): Record<string, readonly ModelChainEntry[]> {
  const out: Record<string, readonly ModelChainEntry[]> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) {
      throw new Error(`配置 ${label}.${name} 必须是数组`)
    }
    out[name] = raw.map((item, index) => {
      const e = asObject(item, `${label}.${name}[${index}]`)
      return {
        provider: asString(e.provider, `${label}.${name}[${index}].provider`),
        model: asString(e.model, `${label}.${name}[${index}].model`),
      }
    })
  }
  return out
}

function parseJevChains(value: Record<string, unknown>): Record<string, readonly JevChainEntry[]> {
  const out: Record<string, readonly JevChainEntry[]> = {}
  for (const [name, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) {
      throw new Error(`配置 jev.chains.${name} 必须是数组`)
    }
    out[name] = raw.map((item, index) => {
      const e = asObject(item, `jev.chains.${name}[${index}]`)
      return {
        provider: asString(e.provider, `jev.chains.${name}[${index}].provider`),
        model: asString(e.model, `jev.chains.${name}[${index}].model`),
      }
    })
  }
  return out
}

function requireChain(chains: Record<string, unknown>, name: string, field: string): void {
  if (!(name in chains)) {
    throw new Error(`配置 ${field} 引用了不存在的链 '${name}'`)
  }
}
