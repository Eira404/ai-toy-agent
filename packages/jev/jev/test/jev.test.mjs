/* global AbortController */
import assert from "node:assert/strict"
import test from "node:test"
import { Context } from "cordis"
import { JevAdapter, JevRuntime } from "toy-jev"

const questions = {
  mood: { type: "choice", instructions: "判断情绪", criteria: { calm: "平静", happy: "开心" } },
}
const answer = { type: "choice", choice: "calm", confidence: 0.9, probabilities: { calm: 0.9 } }

async function setup(t, response) {
  const ctx = new Context()
  await ctx.plugin(JevRuntime)
  t.after(() => ctx.fiber.dispose())
  class Adapter extends JevAdapter {
    async invoke(request) {
      return response(request)
    }
  }
  return { jev: ctx.jev, Adapter }
}

test("校验请求并路由到唯一适配器，多个路由时要求指定 provider", async (t) => {
  const { jev, Adapter } = await setup(t, ({ provider, state }) => {
    assert.equal(state, "今天不错")
    return { model: provider, answers: { mood: answer } }
  })
  const unregister = jev.registerAdapter("fake", new Adapter())
  assert.equal((await jev.invoke(" 今天不错 ", questions, { model: "demo" })).model, "fake")
  await assert.rejects(jev.invoke(" ", questions, { model: "demo" }), { code: "INVALID_REQUEST" })
  await assert.rejects(jev.invoke("今天不错", {}, { model: "demo" }), { code: "INVALID_REQUEST" })
  jev.registerAdapter("other", new Adapter())
  await assert.rejects(jev.invoke("今天不错", questions, { model: "demo" }), { code: "NO_ADAPTER" })
  assert.equal(
    (await jev.invoke("今天不错", questions, { provider: "other", model: "demo" })).model,
    "other",
  )
  unregister()
  assert.deepEqual(
    jev.listProviders().map(({ id }) => id),
    ["other"],
  )
})

test("拒绝缺失、类型不符、候选范围外和多余的答案", async (t) => {
  let answers
  const { jev, Adapter } = await setup(t, () => ({ model: "fake", answers }))
  jev.registerAdapter("fake", new Adapter())
  for (const invalid of [
    {},
    { mood: { type: "noul", noul: 0.5 } },
    { mood: { ...answer, choice: "outside" } },
    { mood: answer, unexpected: answer },
  ]) {
    answers = invalid
    await assert.rejects(jev.invoke("state", questions, { model: "demo" }), { code: "INVALID_RESPONSE" })
  }
})

test("已取消的请求不执行评估适配器", async (t) => {
  let invoked = false
  const { jev, Adapter } = await setup(t, () => {
    invoked = true
    return { model: "fake", answers: { mood: answer } }
  })
  jev.registerAdapter("fake", new Adapter())
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(jev.invoke("state", questions, { model: "demo", signal: controller.signal }), {
    code: "ABORTED",
  })
  assert.equal(invoked, false)
})
