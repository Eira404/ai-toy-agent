/** 本地人设目录的一项：把玩偶人设名映射成完整 system prompt 文本。 */
export interface PersonaPrompt {
  readonly id: string
  readonly label: string
  readonly systemPrompt: string
}
