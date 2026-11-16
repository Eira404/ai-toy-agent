/** 从 `ctx.llm.generate` 的返回中拼接全部文本块。 */
export function extractText(result: {
  readonly content: readonly { type: string; text?: string }[]
}): string {
  let text = ""
  for (const block of result.content) {
    if (block.type === "text" && block.text !== undefined) {
      text += block.text
    }
  }
  return text
}
