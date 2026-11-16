/**
 * 极简 YAML 子集解析器（零第三方依赖，专为本应用配置服务）。
 *
 * 支持：
 * - `#` 注释（到行尾；值里含 `#` 需用引号包裹）
 * - 缩进嵌套 mapping：`key: value` 或 `key:`（挂子块）
 * - `- ` 开头 sequence：支持标量项与「同一项多行 mapping」
 *   （`- key: value` 后接更深缩进的续行）
 * - 标量：裸字符串或单/双引号字符串；一律按字符串返回，类型由 config 层转换
 *
 * 不支持（本配置未用到）：flow 集合 `{...}`/`[...]`、多行文本块、锚点/别名、类型标签。
 */

interface Line {
  readonly indent: number
  readonly content: string
}

/** 解析 YAML 文本为嵌套的 `对象 / 数组 / 字符串`（叶子均为字符串）。 */
export function parseYaml(text: string): unknown {
  const lines: Line[] = []
  for (const raw of text.split(/\r?\n/)) {
    const stripped = stripComment(raw)
    if (stripped.trim() === "") continue
    const indent = stripped.length - stripped.trimStart().length
    lines.push({ indent, content: stripped.trim() })
  }
  if (lines.length === 0) return {}
  const root = lines[0]!
  return parseBlock(lines, 0, root.indent).value
}

function stripComment(line: string): string {
  const hash = line.indexOf("#")
  return hash < 0 ? line : line.slice(0, hash)
}

function isSequenceItem(content: string): boolean {
  return content === "-" || content.startsWith("- ")
}

function parseBlock(
  lines: readonly Line[],
  index: number,
  indent: number,
): { value: unknown; next: number } {
  const line = lines[index]
  if (line === undefined || line.indent < indent) {
    return { value: {}, next: index }
  }
  return isSequenceItem(line.content)
    ? parseSequence(lines, index, indent)
    : parseMapping(lines, index, indent)
}

function parseMapping(
  lines: readonly Line[],
  index: number,
  indent: number,
): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent !== indent || isSequenceItem(line.content)) break
    const colon = line.content.indexOf(":")
    if (colon < 0) throw new Error(`无法解析的配置行: "${line.content}"`)
    const key = line.content.slice(0, colon).trim()
    const rest = line.content.slice(colon + 1).trim()
    if (key === "") throw new Error(`配置行缺少 key: "${line.content}"`)
    if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1]!.indent)
        obj[key] = child.value
        i = child.next
      } else {
        obj[key] = null
        i += 1
      }
    } else {
      obj[key] = parseScalar(rest)
      i += 1
    }
  }
  return { value: obj, next: i }
}

function parseSequence(
  lines: readonly Line[],
  index: number,
  indent: number,
): { value: unknown[]; next: number } {
  const arr: unknown[] = []
  let i = index
  while (i < lines.length) {
    const line = lines[i]!
    if (line.indent !== indent || !isSequenceItem(line.content)) break
    const rest = line.content === "-" ? "" : line.content.slice(2).trim()
    if (rest === "") {
      if (i + 1 < lines.length && lines[i + 1]!.indent > indent) {
        const child = parseBlock(lines, i + 1, lines[i + 1]!.indent)
        arr.push(child.value)
        i = child.next
      } else {
        arr.push(null)
        i += 1
      }
    } else if (rest.includes(":")) {
      const child = parseInlineMapItem(lines, i, indent)
      arr.push(child.value)
      i = child.next
    } else {
      arr.push(parseScalar(rest))
      i += 1
    }
  }
  return { value: arr, next: i }
}

/** 解析 `- key: value` 开头的列表项，并把更深缩进的续行并入同一项。 */
function parseInlineMapItem(
  lines: readonly Line[],
  index: number,
  indent: number,
): { value: Record<string, unknown>; next: number } {
  const obj: Record<string, unknown> = {}
  let i = index
  while (i < lines.length) {
    const line = lines[i]!
    const content = i === index ? line.content.slice(2).trim() : line.content
    const colon = content.indexOf(":")
    if (colon < 0) throw new Error(`无法解析的列表项行: "${line.content}"`)
    const key = content.slice(0, colon).trim()
    const rest = content.slice(colon + 1).trim()
    if (key === "") throw new Error(`列表项缺少 key: "${line.content}"`)
    obj[key] = rest === "" ? null : parseScalar(rest)
    i += 1
    if (i < lines.length && lines[i]!.indent > indent && !isSequenceItem(lines[i]!.content)) {
      continue
    }
    break
  }
  return { value: obj, next: i }
}

function parseScalar(raw: string): string {
  const s = raw.trim()
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1)
  }
  return s
}
