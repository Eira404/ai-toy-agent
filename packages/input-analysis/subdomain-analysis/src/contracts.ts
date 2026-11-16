import { z } from "zod"
import { PRIMARY_DOMAIN_NAMES } from "toy-query-analysis"
import { SUBDOMAIN_CATALOG, SUBDOMAIN_NAMES } from "./subdomain-catalog.js"

export const SubdomainAnalysisInputSchema = z.object({
  query: z.string().trim().min(1, "重写后的 Query 不能为空"),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1),
      }),
    )
    .default([]),
  primaryDomain: z.enum(PRIMARY_DOMAIN_NAMES),
  secondaryDomains: z.array(z.enum(PRIMARY_DOMAIN_NAMES)).default([]),
})

export const SubdomainScoreSchema = z.object({
  domain: z.enum(PRIMARY_DOMAIN_NAMES),
  name: z.enum(SUBDOMAIN_NAMES),
  score: z.number(),
})

export const SubdomainAnalysisResultSchema = z.object({
  subdomains: z.array(SubdomainScoreSchema).min(1).max(3),
})

export type SubdomainAnalysisInput = z.input<typeof SubdomainAnalysisInputSchema>
export type ParsedSubdomainAnalysisInput = z.output<typeof SubdomainAnalysisInputSchema>
export type SubdomainScore = z.infer<typeof SubdomainScoreSchema>
export type SubdomainAnalysisResult = z.infer<typeof SubdomainAnalysisResultSchema>

export function getSubdomainCandidates(input: ParsedSubdomainAnalysisInput) {
  const domains = new Set([input.primaryDomain, ...input.secondaryDomains])
  return SUBDOMAIN_CATALOG.filter((domain) => domains.has(domain.primaryDomain))
}
