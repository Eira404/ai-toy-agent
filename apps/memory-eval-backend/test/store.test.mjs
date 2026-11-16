import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendLine, readLines, writeRun, readRun, hashConfig } from "../store.mjs"

async function tmp() {
  return mkdtemp(join(tmpdir(), "eval-store-"))
}

test("appendLine + readLines 往返", async () => {
  const dir = await tmp()
  const file = join(dir, "a.jsonl")
  try {
    await appendLine(file, { a: 1 })
    await appendLine(file, { b: 2, c: "中" })
    assert.deepEqual(readLines(file), [{ a: 1 }, { b: 2, c: "中" }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("readLines 丢弃末尾残行", async () => {
  const dir = await tmp()
  const file = join(dir, "b.jsonl")
  try {
    await writeFile(file, '{"a":1}\n{"b":', "utf8")
    assert.deepEqual(readLines(file), [{ a: 1 }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("readLines 文件不存在返回空数组", () => {
  assert.deepEqual(readLines(join(tmpdir(), "does-not-exist.jsonl")), [])
})

test("writeRun / readRun 原子读写", async () => {
  const dir = await tmp()
  const file = join(dir, "run.json")
  try {
    await writeRun(file, { runId: "r1", status: "running" })
    assert.deepEqual(readRun(file), { runId: "r1", status: "running" })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("readRun 文件缺失返回 null", () => {
  assert.equal(readRun(join(tmpdir(), "nope.json")), null)
})

test("hashConfig 稳定且随输入变化", () => {
  assert.equal(hashConfig("a", "b", 1), hashConfig("a", "b", 1))
  assert.notEqual(hashConfig("a", "b", 1), hashConfig("a", "b", 2))
})
