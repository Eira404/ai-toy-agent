/* global AbortController, Headers, ReadableStream, Response, TextEncoder */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { LlmRuntime } from "toy-llm"
import { OpenAICompatiblePlugin } from "toy-llm-openai-compatible"

const input = { provider: "test", model: "model", messages: [] }

async function setup(t, fetch, options = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const fiber = await ctx.plugin(OpenAICompatiblePlugin, {
    provider: "test",
    baseURL: "https://provider.test/v1/",
    apiKey: "fixture-key",
    fetch,
    ...options,
  })
  t.after(() => ctx.fiber.dispose())
  return { llm: ctx.llm, fiber }
}

function streamResponse(events) {
  const wire = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  const bytes = new TextEncoder().encode(`${wire}data: [DONE]\r\n\r\n`)
  // 逐字节发送，覆盖换行、帧头和中文 UTF-8 被拆成多段的情况。
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(Uint8Array.of(byte))
        }
        controller.close()
      },
    }),
  )
}

test("显式关闭思考时省略路由默认思考预算", async (t) => {
  let body
  const { llm } = await setup(
    t,
    async (_url, request) => {
      body = JSON.parse(request.body)
      return streamResponse([{ choices: [{ delta: { content: "结果" }, finish_reason: "stop" }] }])
    },
    { enableThinking: true, thinkingBudget: 2048 },
  )
  const result = await llm.generate({ ...input, reasoning: { enabled: false } })
  assert.equal(result.finish.kind, "stop")
  assert.equal(body.enable_thinking, false)
  assert.equal(body.thinking_budget, undefined)
})

test("发送 Chat Completions 请求并组装跨分片的文本、推理和工具参数", async (t) => {
  let calls = 0
  const argumentsText = JSON.stringify({ city: "上海" })
  const split = argumentsText.indexOf(":") + 1
  const { llm, fiber } = await setup(t, async (url, request) => {
    calls += 1
    assert.equal(url, "https://provider.test/v1/chat/completions")
    assert.equal(new Headers(request.headers).get("authorization"), "Bearer fixture-key")
    const body = JSON.parse(request.body)
    assert.equal(body.stream, true)
    assert.deepEqual(body.messages, [{ role: "user", content: "查天气" }])
    assert.equal(body.tools[0].function.name, "weather")
    assert.equal(body.response_format.json_schema.name, "result")
    return streamResponse([
      { choices: [{ delta: { reasoning_content: "思考", content: "查询中" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "c1",
                  function: { name: "weather", arguments: argumentsText.slice(0, split) },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(split) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          prompt_tokens_details: null,
        },
      },
    ])
  })
  const result = await llm.generate({
    ...input,
    messages: [{ role: "user", content: [{ type: "text", text: "查天气" }] }],
    tools: [
      { kind: "function", name: "weather", description: "查询", parameters: { type: "object" } },
    ],
    responseFormat: { type: "json_schema", name: "result", schema: { type: "object" } },
  })
  assert.deepEqual(result, {
    content: [
      { type: "reasoning", text: "思考" },
      { type: "text", text: "查询中" },
      { type: "tool-call", id: "c1", name: "weather", arguments: argumentsText },
    ],
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    finish: { kind: "tool-calls" },
  })
  assert.equal(calls, 1)
  await fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
})

test("保留模型返回的原始无效参数，HTTP 429 返回诊断信息且只请求一次", async (t) => {
  let calls = 0
  const { llm } = await setup(t, async () => {
    calls += 1
    if (calls === 1) {
      return streamResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c", function: { name: "lookup", arguments: "{bad" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ])
    }
    return new Response("try later", {
      status: 429,
      headers: { "retry-after": "2", "x-request-id": "request-1" },
    })
  })
  assert.equal((await llm.generate(input)).content[0].arguments, "{bad")
  const { finish } = await llm.generate(input)
  assert.deepEqual(finish, {
    kind: "error",
    failure: {
      message: "try later",
      code: "RATE_LIMIT",
      status: 429,
      requestId: "request-1",
      retryAfterMs: 2000,
    },
  })
  assert.equal(calls, 2)
})

test("中断正在等待的 SSE 读取并返回 aborted", { timeout: 2_000 }, async (t) => {
  const controller = new AbortController()
  let notifyRead
  const reading = new Promise((resolve) => {
    notifyRead = resolve
  })
  let cancelled = false
  const { llm } = await setup(
    t,
    async () =>
      new Response(
        new ReadableStream(
          {
            pull() {
              notifyRead()
            },
            cancel() {
              cancelled = true
            },
          },
          { highWaterMark: 0 },
        ),
      ),
  )
  const result = llm.generate({ ...input, signal: controller.signal })
  await reading
  controller.abort()
  assert.equal((await result).finish.kind, "aborted")
  assert.equal(cancelled, true)
})
