export { FastWrite, FastWrite as default } from "./service.js"
export { FastWriteError } from "./error.js"
export type { FastWriteErrorCode } from "./error.js"
export { FastDraftSchema, FastExtractionOutputSchema, fastExtractionJsonSchema } from "./schema.js"
export type { ExtractedDraft, FastExtractionOutput } from "./schema.js"
export { buildUserMessage, FAST_EXTRACT_SYSTEM_MESSAGE } from "./prompts.js"
export type { FastExtractConfig, ResolvedFastExtractConfig } from "./config.js"
export type {
  ConversationItem,
  ExtractWait,
  FastExtractInput,
  FastExtractResult,
  FastWriteInput,
  FastWriteResult,
} from "./types.js"
