export { LongMemory, LongMemory as default } from "./service.js"
export { LongMemoryError } from "./error.js"
export type { LongMemoryErrorCode } from "./error.js"
export {
  defineLongVectorSchema,
  longRelationalSchema,
  LONG_ALIASES_TABLE,
  LONG_BLOCKS_TABLE,
  LONG_DETAILS_TABLE,
  LONG_KEYWORDS_TABLE,
  LONG_VECTOR_COLLECTION,
} from "./schema.js"
export { normalizeKey } from "./normalize.js"
export type { LongConfig, ResolvedLongConfig } from "./config.js"
export type {
  LifecycleStatus,
  ListLongInput,
  LongApplyResult,
  LongBlock,
  LongBlockChange,
  LongBlockContent,
  LongBlockCursor,
  LongBlockHit,
  LongBlockHitReason,
  LongBlockPage,
  LongBlockSummary,
  LongChangeSet,
  LongDetail,
  LongDetailChange,
  LongDetailHit,
  LongDomain,
  LongSearchInput,
  LongSearchResult,
  ValueState,
  Scope,
} from "./types.js"
