/* global fetch, EventSource, document */
// 极简前端：启动评测 + 进度 + 分能力得分 + 单题 drill-down，SSE 推送刷新。

const state = { run: null, results: [], running: null }

async function load() {
  const [run, results, running] = await Promise.all([
    fetch("/api/run").then((r) => r.json()),
    fetch("/api/results").then((r) => r.json()),
    fetch("/api/running").then((r) => r.json()),
  ])
  state.run = run ?? state.run
  state.results = results ?? state.results
  state.running = running ?? state.running
  render()
}

function render() {
  renderMeta()
  renderRunning()
  renderProgress()
  renderOverall()
  renderGroups()
  renderQuestions()
}

function renderMeta() {
  const el = document.getElementById("run-meta")
  const run = state.run
  if (!run) {
    el.textContent = "暂无运行数据（启动一次评测，或在下方开始）"
    return
  }
  el.textContent = `runId=${run.runId} · adapter=${run.adapterId} · mode=${run.mode} · status=${run.status}`
}

function renderRunning() {
  const badge = document.getElementById("running-badge")
  if (state.running) {
    badge.classList.remove("hidden")
    badge.textContent = `评测运行中… ${state.running.adapterId}`
  } else {
    badge.classList.add("hidden")
  }
}

function renderProgress() {
  const run = state.run
  const judged = run?.counters?.judged ?? state.results.length
  const judgedTotal = run?.counters?.judgedTotal ?? 0
  const pct = judgedTotal === 0 ? 0 : (judged / judgedTotal) * 100
  document.getElementById("progress-fill").style.width = `${pct}%`
  document.getElementById("progress-text").textContent =
    `题 ${judged}/${judgedTotal} · extract ${run?.counters?.extractDone ?? 0}/${run?.counters?.extractTotal ?? 0}`
}

function renderOverall() {
  const acc = overallAccuracy(state.results)
  document.getElementById("overall-accuracy").textContent =
    state.results.length === 0 ? "—" : `${(acc * 100).toFixed(1)}%`
}

function renderGroups() {
  const byGroup = new Map()
  for (const r of state.results) {
    const g = r.type ?? "unknown"
    const b = byGroup.get(g) ?? { correct: 0, total: 0 }
    b.total += 1
    if (r.judge?.correct === true) b.correct += 1
    byGroup.set(g, b)
  }
  const el = document.getElementById("group-list")
  if (byGroup.size === 0) {
    el.innerHTML = '<div class="muted">暂无结果</div>'
    return
  }
  el.innerHTML = [...byGroup.entries()]
    .map(([name, b]) => {
      const pct = b.total === 0 ? 0 : (b.correct / b.total) * 100
      return `<div class="group-row">
        <span class="group-name">${esc(name)}</span>
        <div class="group-bar"><div class="group-fill" style="width:${pct}%"></div></div>
        <span class="group-pct">${b.correct}/${b.total} (${pct.toFixed(1)}%)</span>
      </div>`
    })
    .join("")
}

function renderQuestions() {
  const el = document.getElementById("question-list")
  if (state.results.length === 0) {
    el.innerHTML = '<div class="muted">暂无结果</div>'
    return
  }
  el.innerHTML = state.results
    .map((r) => {
      const ok = r.judge?.correct === true
      const retr = retrievedText(r.retrieved)
      return `<details class="question">
        <summary>${esc(r.questionId)} <span class="type muted">${esc(r.type ?? "")}</span>
          <span class="verdict ${ok ? "ok" : "bad"}">${ok ? "✓ 正确" : "✗ 错误"}</span></summary>
        <dl class="detail">
          <dt>题目</dt><dd>${esc(r.question ?? "")}</dd>
          <dt>标准答案</dt><dd>${esc(r.gold ?? "")}</dd>
          <dt>模型回答</dt><dd>${esc(r.predicted ?? "")}</dd>
          <dt>判定</dt><dd>${ok ? "正确" : "错误"} — ${esc(r.judge?.reason ?? "")}</dd>
          <dt>Token</dt><dd>in ${r.tokens?.inputTokens ?? 0} / out ${r.tokens?.outputTokens ?? 0}</dd>
          <dt>检索到的记忆</dt><dd><pre class="mem">${esc(retr || "(空)")}</pre></dd>
        </dl>
      </details>`
    })
    .join("")
}

function overallAccuracy(results) {
  if (results.length === 0) return 0
  return results.filter((r) => r.judge?.correct === true).length / results.length
}

function retrievedText(retrieved) {
  if (!retrieved) return ""
  const parts = []
  for (const f of retrieved.fast ?? []) parts.push(`[Fast] ${f.title}: ${f.body}`)
  for (const b of retrieved.long ?? []) {
    parts.push(`[Long] ${b.title}: ${b.overviewBody}`)
    for (const d of b.details ?? []) parts.push(`  - ${d.summary}: ${d.body}`)
  }
  return parts.join("\n")
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function setupStartForm() {
  const form = document.getElementById("start-form")
  const msg = document.getElementById("start-msg")
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    const data = new FormData(form)
    const body = {
      adapter: data.get("adapter"),
      limit: data.get("limit") === "" ? undefined : Number(data.get("limit")),
      start: data.get("start") === "" ? undefined : Number(data.get("start")),
      concurrency: data.get("concurrency") === "" ? undefined : Number(data.get("concurrency")),
      csv: data.get("csv") === "on",
      data: data.get("data") || undefined,
    }
    msg.textContent = "启动中…"
    try {
      const res = await fetch("/api/run/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      const payload = await res.json()
      if (res.ok) {
        msg.textContent = `已启动：${payload.adapterId} → ${payload.outDir}`
      } else {
        msg.textContent = `启动失败：${payload.error ?? res.status}`
      }
    } catch (error) {
      msg.textContent = `请求失败：${error.message}`
    }
  })
}

function connectSse() {
  const es = new EventSource("/api/events")
  es.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data)
      if (payload.type === "snapshot") {
        state.run = payload.run ?? state.run
        state.results = payload.results ?? state.results
        state.running = payload.running ?? state.running
        render()
      }
    } catch {
      /* ignore malformed events */
    }
  }
}

setupStartForm()
load()
connectSse()
