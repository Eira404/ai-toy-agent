export { FastMemory, FastMemory as default } from "./service.js"
export { FastMemoryError } from "./error.js"
export type { FastMemoryErrorCode } from "./error.js"
export {
  defineFastVectorSchema,
  fastRelationalSchema,
  FAST_JOBS_TABLE,
  FAST_RECORDS_TABLE,
  FAST_VECTOR_COLLECTION,
} from "./schema.js"
export { normalizeTitleKey } from "./title-key.js"
export type { FastConfig, ResolvedFastConfig } from "./config.js"
export type {
  FastAppendInput,
  FastAppendResult,
  FastConsumptionPlan,
  FastCount,
  FastCursor,
  FastDraft,
  FastEmbeddingJobStatus,
  FastHitReason,
  FastPage,
  FastRecord,
  FastSearchHit,
  FastSearchInput,
  FastSearchResult,
  ListFastInput,
  PrepareConsumptionInput,
  RunEmbeddingJobsOptions,
  RunEmbeddingJobsResult,
  Scope,
} from "./types.js"
