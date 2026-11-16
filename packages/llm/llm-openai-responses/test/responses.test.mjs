/* global AbortController, Headers, ReadableStream, Response */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { OpenAIResponsesPlugin } from "toy-llm-openai-responses"

const options = {
  provider: "test-responses",
  model: "test-model",
  messages: [
    { role: "system", content: [{ type: "text", text: "请简洁回答" }] },
    { role: "user", content: [{ type: "text", text: "现在几点？" }] },
  ],
}

function sse(...events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
}

function functionCall(id, callId = `call_${id}`) {
  return { id, type: "function_call", name: "clock", call_id: callId, arguments: "{}" }
}

function toolMessage(id, output) {
  return { role: "tool", toolCallId: id, content: [{ type: "text", text: output }] }
}

function finalText(text) {
  return {
    id: "message",
    type: "message",
    content: [{ type: "output_text", text }],
  }
}

async function setup(t, fetch, extra = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const fiber = await ctx.plugin(OpenAIResponsesPlugin, {
    baseURL: "https://provider.test/v1/",
    apiKey: "fixture",
    provider: options.provider,
    fetch,
    ...extra,
  })
  t.after(() => ctx.fiber.dispose())
  return { llm: ctx.llm, fiber }
}

test("Responses 请求映射、服务端工具和显式响应 ID 续调", async (t) => {
  const requests = []
  const call = functionCall("f1", "call-1")
  const { llm, fiber } = await setup(
    t,
    async (url, request) => {
      assert.equal(url, "https://provider.test/v1/responses")
      assert.equal(new Headers(request.headers).get("authorization"), "Bearer fixture")
      requests.push(JSON.parse(request.body))
      if (requests.length === 1) {
        const search = { type: "web_search_call", id: "search-1", status: "completed" }
        return sse(
          { type: "response.created", response: { id: "resp-1" } },
          { type: "response.output_item.done", output_index: 0, item: search },
          { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
          { type: "response.function_call_arguments.delta", item_id: call.id, delta: "{" },
          { type: "response.function_call_arguments.done", item_id: call.id, arguments: "{}" },
          { type: "response.output_item.done", output_index: 1, item: call },
          {
            type: "response.completed",
            response: {
              id: "resp-1",
              output: [search, call],
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          },
        )
      }
      return sse(
        { type: "response.output_text.delta", item_id: "message", content_index: 0, delta: "十" },
        { type: "response.output_text.done", item_id: "message", content_index: 0, text: "十点" },
        { type: "response.completed", response: { id: "resp-2", output: [finalText("十点")] } },
      )
    },
    { store: true, builtinTools: ["web_search"], reasoningSummary: "auto" },
  )

  const request = {
    ...options,
    reasoning: { enabled: true, effort: "high" },
    maxTokens: 40,
    responseFormat: { type: "json_schema", name: "result", schema: { type: "object" } },
    tools: [
      { kind: "function", name: "clock", description: "读取时间", parameters: { type: "object" } },
      { kind: "builtin", name: "web_search", description: "搜索" },
    ],
  }
  const first = await llm.generate(request)
  assert.deepEqual(first.content, [
    { type: "tool-call", id: "call-1", name: "clock", arguments: "{}" },
  ])
  assert.deepEqual(first.usage, { inputTokens: 5, outputTokens: 2 })
  assert.equal(first.finish.kind, "tool-calls")
  assert.deepEqual(first.continuation, {
    kind: "responses-stored",
    provider: options.provider,
    model: options.model,
    responseId: "resp-1",
    callIds: ["call-1"],
  })
  assert.equal(requests[0].instructions, "请简洁回答")
  assert.equal(requests[0].max_output_tokens, 40)
  assert.deepEqual(requests[0].reasoning, { effort: "high", summary: "auto" })
  assert.equal(requests[0].text.format.name, "result")
  assert.equal(requests[0].tools[0].strict, false)
  assert.deepEqual(requests[0].tools[1], { type: "web_search" })
  assert.deepEqual(llm.providerInfo(options.provider).capabilities.builtinTools, ["web_search"])

  const final = await llm.generate({
    ...request,
    messages: [
      ...request.messages,
      { role: "assistant", content: first.content },
      toolMessage("call-1", "10:00"),
    ],
    continuation: first.continuation,
  })
  assert.deepEqual(final, { content: [{ type: "text", text: "十点" }], finish: { kind: "stop" } })
  assert.equal(requests[1].previous_response_id, "resp-1")
  assert.equal(requests[1].instructions, "请简洁回答")
  assert.deepEqual(requests[1].input, [
    { type: "function_call_output", call_id: "call-1", output: "10:00" },
  ])
  await fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
})

test("默认无状态续调重放加密推理和全部工具 Item", async (t) => {
  const reasoning = {
    id: "reasoning-1",
    type: "reasoning",
    encrypted_content: "fixture-encrypted-content",
    summary: [{ type: "summary_text", text: "需要确认时间" }],
  }
  const calls = [functionCall("f1"), functionCall("f2")]
  const requests = []
  const { llm } = await setup(t, async (_url, { body }) => {
    requests.push(JSON.parse(body))
    if (requests.length === 1) {
      return sse(
        {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoning.id,
          summary_index: 0,
          delta: "需要",
        },
        { type: "response.completed", response: { id: "r1", output: [reasoning, ...calls] } },
      )
    }
    return sse({ type: "response.completed", response: { output: [finalText("十点整")] } })
  })
  const first = await llm.generate(options)
  assert.equal(first.finish.kind, "tool-calls")
  assert.deepEqual(first.content[0], { type: "reasoning", text: "需要确认时间" })
  assert.equal(first.continuation.kind, "responses-stateless")
  assert.equal(requests[0].store, false)
  assert.deepEqual(requests[0].include, ["reasoning.encrypted_content"])
  const continuation = first.continuation

  const invalid = await llm.generate({
    ...options,
    continuation,
    messages: [...options.messages, toolMessage(calls[0].call_id, "10:00")],
  })
  assert.equal(invalid.finish.failure.code, "INVALID_CONTINUATION")
  assert.equal(requests.length, 1)

  const final = await llm.generate({
    ...options,
    continuation,
    messages: [
      ...options.messages,
      toolMessage(calls[1].call_id, "UTC"),
      toolMessage(calls[0].call_id, "10:00"),
    ],
  })
  assert.equal(final.finish.kind, "stop")
  assert.equal(requests[1].previous_response_id, undefined)
  assert.deepEqual(requests[1].input, [
    { role: "user", content: "现在几点？" },
    reasoning,
    ...calls,
    { type: "function_call_output", call_id: calls[0].call_id, output: "10:00" },
    { type: "function_call_output", call_id: calls[1].call_id, output: "UTC" },
  ])
})

test("显式关闭思考用 effort none，思考预算拒绝在 HTTP 请求之前", async (t) => {
  let body
  const { llm } = await setup(
    t,
    async (_url, request) => {
      body = JSON.parse(request.body)
      return sse({ type: "response.completed", response: { output: [finalText("结果")] } })
    },
    { reasoningSummary: "auto" },
  )
  const disabled = await llm.generate({
    ...options,
    reasoning: { enabled: false, budgetTokens: 2048 },
  })
  assert.equal(disabled.finish.kind, "stop")
  assert.deepEqual(body.reasoning, { effort: "none" })
  assert.equal(body.include, undefined)
  body = undefined
  const unsupported = await llm.generate({
    ...options,
    reasoning: { enabled: true, budgetTokens: 2048 },
  })
  assert.equal(unsupported.finish.failure.code, "UNSUPPORTED_OPTION")
  assert.equal(body, undefined)
})

test("保留不完整、错误和 HTTP 限流的终止原因", async (t) => {
  const fixtures = [
    sse({
      type: "response.incomplete",
      response: {
        incomplete_details: { reason: "max_output_tokens" },
        output: [finalText("partial")],
      },
    }),
    sse({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "content_filter" } },
    }),
    sse({
      type: "response.failed",
      response: { error: { code: "server_error", message: "failed" } },
    }),
    sse({ type: "response.output_text.delta", item_id: "message", delta: "partial" }),
    new Response("limited", { status: 429, headers: { "retry-after": "2" } }),
  ]
  const { llm } = await setup(t, async () => fixtures.shift())
  const partial = await llm.generate(options)
  assert.equal(partial.finish.kind, "max-tokens")
  assert.deepEqual(partial.content, [{ type: "text", text: "partial" }])
  for (const code of ["CONTENT_FILTER", "server_error", "STREAM_CLOSED", "RATE_LIMIT"]) {
    assert.equal((await llm.generate(options)).finish.failure.code, code)
  }
  assert.deepEqual(fixtures, [])
})

test("取消会中断 Responses SSE 读取", { timeout: 2_000 }, async (t) => {
  const controller = new AbortController()
  let start
  const reading = new Promise((resolve) => {
    start = resolve
  })
  let released = false
  const { llm } = await setup(
    t,
    async () =>
      new Response(
        new ReadableStream(
          {
            pull: () => start(),
            cancel: () => {
              released = true
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  )
  const task = llm.generate({ ...options, signal: controller.signal })
  await reading
  controller.abort()
  assert.equal((await task).finish.kind, "aborted")
  assert.equal(released, true)
})
