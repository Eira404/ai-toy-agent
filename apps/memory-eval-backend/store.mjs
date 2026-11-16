/**
 * JSONL 读写 + run.json 原子读写（对齐 REQUIREMENTS.md §5）。
 *
 * 写入方式：整行 append + fsync（崩溃安全、不交错）；run.json 用临时文件 + rename 原子替换。
 */
import { createHash } from "node:crypto"
import { open, readFile, rename, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"

/**
 * 向 JSONL 文件追加一行（JSON 对象），写完后 fsync 落盘。
 *
 * @param {string} filePath 目标 JSONL 路径。
 * @param {unknown} obj 可 JSON 序列化的对象。
 */
export async function appendLine(filePath, obj) {
  const handle = await open(filePath, "a")
  try {
    await handle.writeFile(JSON.stringify(obj) + "\n", "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * 读取 JSONL 文件为对象数组；文件不存在返回空数组；末尾写一半的残行被丢弃。
 *
 * @param {string} filePath JSONL 路径。
 * @returns {unknown[]} 解析出的对象数组。
 */
export function readLines(filePath) {
  let text
  try {
    text = readFileSync(filePath, "utf8")
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return []
    }
    throw error
  }
  const out = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line.length === 0) {
      continue
    }
    try {
      out.push(JSON.parse(line))
    } catch {
      // 残行/损坏行跳过，不阻断整批读取。
    }
  }
  return out
}

/**
 * 原子写 run.json：先写临时文件再 rename。
 *
 * @param {string} filePath run.json 路径。
 * @param {unknown} obj 内容。
 */
export async function writeRun(filePath, obj) {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8")
  await rename(tmp, filePath)
}

/**
 * 读取 run.json；缺失或解析失败返回 null。
 *
 * @param {string} filePath run.json 路径。
 * @returns {Record<string, unknown> | null}
 */
export function readRun(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

/**
 * 配置指纹：用于判断「同一次运行」的配置是否一致（断点恢复时校验）。
 *
 * @param {...unknown} parts 参与哈希的配置片段。
 * @returns {string} 16 位 hex 指纹。
 */
export function hashConfig(...parts) {
  return createHash("sha256")
    .update(parts.map((p) => String(p)).join("|"))
    .digest("hex")
    .slice(0, 16)
}

/** 当前 ISO 时间串。 */
export function nowIso() {
  return new Date().toISOString()
}
