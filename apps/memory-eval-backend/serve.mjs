/**
 * 极简 Web 服务：静态前端 + JSON API + SSE 进度推送 + 通过 Web 启动评测。
 *
 * 用法：node serve.mjs [--out runs/<runDir>] [--port 8642]
 * 自动读取本目录 `.env`；不传 --out 时初始展示 runs/ 下最新修改的 run.json。
 */
import "./env.mjs"
import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { readRun, readLines } from "./store.mjs"
import { createAdapter } from "./adapter-factory.mjs"
import { runOnce } from "./run-once.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const webDir = join(__dirname, "web")
const runsDir = join(__dirname, "runs")

const args = parseArgs(process.argv.slice(2))
const port = args.port ?? 8642
let currentOutDir = resolve(args.out ?? autoDetectRunDir())

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
}

const sseClients = new Set()
let lastRunJson = null
let lastResultsCount = -1
let lastRunningJson = null

/** 当前正在运行的评测；null 表示空闲。 */
let running = null

const runFile = () => join(currentOutDir, "run.json")
const resultsFile = () => join(currentOutDir, "results.jsonl")

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  const path = url.pathname

  if (path === "/api/events") {
    return setupSse(res)
  }
  if (path === "/api/running" && req.method === "GET") {
    return sendJson(res, running)
  }
  if (path === "/api/run/start" && req.method === "POST") {
    return handleStart(req, res)
  }
  if (path === "/api/run" && req.method === "GET") {
    return sendJson(res, readRun(runFile()))
  }
  if (path === "/api/results" && req.method === "GET") {
    return sendJson(res, readLines(resultsFile()))
  }
  if (path.startsWith("/api/question/") && req.method === "GET") {
    const id = decodeURIComponent(path.slice("/api/question/".length))
    const hit = readLines(resultsFile()).filter((line) => line.questionId === id)
    return sendJson(res, hit[0] ?? null)
  }
  if (path === "/") {
    return sendFile(res, join(webDir, "index.html"))
  }
  const filePath = join(webDir, path.replace(/^\/+/, ""))
  if (filePath.startsWith(webDir) && existsSync(filePath)) {
    return sendFile(res, filePath)
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
  res.end("Not Found")
})

server.listen(port, "127.0.0.1", () => {
  console.log(`memory-eval web: http://127.0.0.1:${port}`)
  console.log(`运行目录：${currentOutDir}`)
})

// SSE：轮询 run.json + results.jsonl + running 状态，变化时推送快照。
const poller = setInterval(() => {
  const run = readRun(runFile())
  const runJson = run === null ? null : JSON.stringify(run)
  const resultsCount = readLines(resultsFile()).length
  const runningJson = JSON.stringify(running)
  if (runJson !== lastRunJson || resultsCount !== lastResultsCount || runningJson !== lastRunningJson) {
    lastRunJson = runJson
    lastResultsCount = resultsCount
    lastRunningJson = runningJson
    broadcast({ type: "snapshot", run, results: readLines(resultsFile()), running })
  }
}, 1000)

/** 通过 Web 启动一次评测（fire-and-forget）。 */
async function handleStart(req, res) {
  if (running !== null) {
    return sendJson(res, { ok: false, error: "已有评测在运行中，请稍候" }, 409)
  }
  let body
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, { ok: false, error: "请求体不是合法 JSON" }, 400)
  }

  let adapter
  try {
    adapter = createAdapter({
      ...body,
      ...(body.data === undefined || body.data === "" ? {} : { data: resolve(__dirname, body.data) }),
    })
  } catch (error) {
    return sendJson(res, { ok: false, error: error.message }, 400)
  }

  const outDir = resolve(body.out ?? join(runsDir, `${adapter.id}-${Date.now()}`))
  currentOutDir = outDir
  running = { adapterId: adapter.id, outDir, startedAt: Date.now() }
  sendJson(res, { ok: true, adapterId: adapter.id, outDir }, 202)

  void (async () => {
    try {
      await adapter.load()
      const result = await runOnce(adapter, {
        outDir,
        concurrency: body.concurrency ?? 10,
        csv: body.csv === true,
      })
      console.log(`[serve] run ${result.run.runId} 完成（${result.run.status}）`)
    } catch (error) {
      console.error("[serve] run 失败：", error)
    } finally {
      running = null
    }
  })()
}

function setupSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  res.write(": connected\n\n")
  res.write(
    `data: ${JSON.stringify({ type: "snapshot", run: readRun(runFile()), results: readLines(resultsFile()), running })}\n\n`,
  )
  sseClients.add(res)
  res.on("close", () => sseClients.delete(res))
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    res.write(data)
  }
}

function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      raw += chunk
    })
    req.on("end", () => {
      try {
        resolvePromise(JSON.parse(raw))
      } catch (error) {
        rejectPromise(error)
      }
    })
    req.on("error", rejectPromise)
  })
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

async function sendFile(res, filePath) {
  const ext = filePath.slice(filePath.lastIndexOf("."))
  const body = await readFile(filePath)
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" })
  res.end(body)
}

/** 自动选择 runs/ 下最新修改的 run.json 目录。 */
function autoDetectRunDir() {
  if (!existsSync(runsDir)) {
    return runsDir
  }
  let best = null
  let bestTime = 0
  for (const name of readdirSync(runsDir)) {
    const candidate = join(runsDir, name)
    const runJson = join(candidate, "run.json")
    if (!existsSync(runJson)) {
      continue
    }
    const mtime = statSync(runJson).mtimeMs
    if (mtime > bestTime) {
      bestTime = mtime
      best = candidate
    }
  }
  return best ?? runsDir
}

function parseArgs(tokens) {
  const out = {}
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.startsWith("--")) {
      const key = token.slice(2)
      const next = tokens[i + 1]
      if (next === undefined || next.startsWith("--")) {
        out[key] = true
      } else {
        const num = Number(next)
        out[key] = Number.isFinite(num) ? num : next
        i += 1
      }
    }
  }
  return out
}

process.on("SIGINT", () => {
  clearInterval(poller)
  server.close()
  process.exit(0)
})
