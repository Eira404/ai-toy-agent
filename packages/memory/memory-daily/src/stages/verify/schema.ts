import { z } from "zod"

export const VERIFY_ISSUE_TYPES = [
  "CONTRADICTED",
  "UNSUPPORTED",
  "MISSING",
  "DUPLICATED",
  "MISPLACED",
  "INVALID_ALIAS",
  "MISLEADING_TITLE",
  "MISLEADING_SUMMARY",
] as const

export type VerifyIssueType = (typeof VERIFY_ISSUE_TYPES)[number]

const VerifyIssueSchema = z
  .object({
    type: z.enum(VERIFY_ISSUE_TYPES),
    field: z.string().min(1),
    snippet: z.string(),
    evidence: z.string(),
    suggestion: z.string(),
  })
  .strict()

export const VerifyOutputSchema = z.discriminatedUnion("verdict", [
  z.object({ verdict: z.literal("PASS") }).strict(),
  z.object({ verdict: z.literal("ISSUES"), issues: z.array(VerifyIssueSchema).min(1) }).strict(),
])

export type VerifyOutput = z.infer<typeof VerifyOutputSchema>
export const verifyJsonSchema = VerifyOutputSchema.toJSONSchema() as unknown as Readonly<
  Record<string, unknown>
>
