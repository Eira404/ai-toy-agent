export const STAGE_5_SHORTEN_SYSTEM_MESSAGE = `
将以下内容压缩到目标字数以内。

**核心目标：** 在不丢失关键事实、不改变原意、不引入新信息的前提下，尽可能减少文本长度。压缩应优先消除冗余表达，而不是笼统概括或删除具体事实。

**压缩规则：**

1. **保留核心事实**：完整保留与记忆理解和后续检索有关的关键信息，包括主体、对象、人物关系、时间、地点、事件、数值、条件、状态、原因及结果等。根据原文实际内容选择，不要求每项都出现。
2. **保留事实关系**：明确谁、在什么时间、什么情况下，对什么对象做了什么或具有何种关系。不能只保留关键词而丢失它们之间的联系。
3. **保留时间状态**：区分过去、现在和未来，保留重要的时间顺序及状态变化。不能将历史事实改写为当前事实，也不能将计划改写为已完成事项。
4. **保留限定条件**：不得遗漏否定、限制、例外、适用范围及不确定性。例如「可能」「仅限」「尚未确定」等表达不能随意删除。
5. **合并重复信息**：对于主体、事实和适用时间一致的重复内容，可以合并表达；对于不同时间、不同主体或存在差异的内容，不得强行合并。
6. **精简表达**：删除重复描述、无实际信息价值的修饰语、口语填充、重复背景及不影响事实理解的解释。可以调整语序、合并句子，使用更简洁的表达。
7. **禁止信息推断**：不得补充原文没有明确提供的人物关系、时间、地点、原因、结论等信息；不得根据常识或上下文自行推测缺失事实。
8. **控制信息优先级**：字数不足时，优先保留核心事实、明确关系、当前状态、重要变化、关键决策及其限制条件；优先删除次要背景、重复内容和非必要描述。

**长度要求：**
- 压缩结果不得超过指定目标字数。
- 如果无法在目标字数内完整保留全部关键事实，不得通过篡改或隐瞒事实强行满足长度要求，应在最开始声明无法无损压缩的标识。

**输出要求：**
仅输出压缩后的内容，不解释压缩过程，不添加原文没有的标题或信息。
`.trim()

export function buildShortenUserMessage(
  fieldLabel: string,
  targetLength: number,
  content: string,
): string {
  return `字段：${fieldLabel}\n目标字数：${targetLength} 字以内\n当前内容：\n${content}`
}

// ============ 阶段五 · 第一遍（overview 溢出分配） ============

export const STAGE_5_OVERVIEW_CAPACITY_SYSTEM_MESSAGE = `
你正在整理一个记忆块的「当下概括」，其正文已超过字数限制，需要把内容重新分配到「当下概括」和「细节补充」。

**任务：**
读取当前「当下概括」和该块的全部「细节补充」，输出：
1. 新的「当下概括」正文（精简到目标字数以内，只保留直接影响后续回答的核心认知）；
2. 从「当下概括」移出、但仍需保留的内容，逐段决定去向：
   - 与某条已有细节属于同一子主题 → 用 UPDATE_EXISTING_DETAIL 合并进该细节；
   - 不属于任何已有细节 → 用 CREATE_FROM_OVERVIEW 创建新细节。

**分配规则：**
1. 保留核心：当前状态、当前有效的限制、关键结论等会直接影响回答的内容留在「当下概括」。
2. 移出非核心：具体经历、变化过程、项目细节、补充背景等有价值但非每次都需要的内容移入细节。
3. 合并同主题：移出的内容若与已有细节同子主题，必须合并进该细节，不要重复新建。
4. 保持事实：不得删除任何有效事实，不得改写语义，不得补充原文没有的新事实。
5. 细节自包含：每条细节的 summary 是用于检索的高密度摘要，body 是完整、自包含的正文，不依赖「它 / 那个 / 之前」等指代。

**输出要求：**
- 新的「当下概括」不得超过目标字数；
- 移出到细节的内容不再受字数限制（由下一遍处理）。
`.trim()

export function buildOverviewCapacityUserMessage(
  title: string,
  summary: string,
  overviewBody: string,
  nowLength: number,
  targetLength: number,
  details: readonly { detailId: string; summary: string; body: string }[],
): string {
  const detailsStr =
    details.length === 0
      ? "（无）"
      : details
          .map((d) => `DetailId:${d.detailId}\nDetailSummary:${d.summary}\nDetailBody:${d.body}`)
          .join("\n---\n")
  return [
    `Title:${title}`,
    `Summary:${summary}`,
    `当下概括正文（当前 ${nowLength} 字，目标 ${targetLength} 字以内）：`,
    overviewBody,
    "已有细节：",
    detailsStr,
  ].join("\n")
}

// ============ 阶段五 · 第二遍（detail 超限处理） ============

export const STAGE_5_DETAIL_CAPACITY_SYSTEM_MESSAGE = `
以下是一些超过字数限制的「细节补充」，需要逐个处理。

**任务：**
对每条超限细节，选择一种处理方式：
1. REWRITE：去除同一细节内部的重复表达，重新概括到目标字数以内；
2. SPLIT：按子主题、时间段或经历边界拆成多条独立的 summary + body。

**规则：**
1. 同一事实不能在多条拆分结果中重复出现。
2. 每条结果的 summary 是检索摘要，body 是完整自包含正文。
3. 不得删除有效事实、不得补充原文没有的新事实。
4. 拆分时原 detailId 保留给其中一条，其余由程序分配新 id（你不需要关心 id）。
`.trim()

export function buildDetailCapacityUserMessage(
  details: readonly { detailId: string; summary: string; body: string; nowLength: number }[],
  targetLength: number,
): string {
  return details
    .map(
      (d) =>
        `DetailId:${d.detailId}\nDetailSummary:${d.summary}\nDetailBody:${d.body}\n当前 ${d.nowLength} 字，目标 ${targetLength} 字以内`,
    )
    .join("\n---\n")
}
