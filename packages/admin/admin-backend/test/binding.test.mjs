import assert from "node:assert/strict"
import test from "node:test"
import { httpBinding, ADMIN_HTTP_METHODS } from "../lib/index.js"

test("httpBinding 提供明确默认值、规范化路径并冻结元数据", () => {
  assert.deepEqual(httpBinding({ method: "POST", path: "/example/double/" }), {
    transport: "http",
    method: "POST",
    path: "/example/double",
    inputSource: "body",
    responseMode: "json",
  })
  const binding = httpBinding({ method: "GET", path: "/example/items" })
  assert.equal(binding.inputSource, "query")
  assert.equal(Object.isFrozen(binding), true)
  assert.throws(() => {
    binding.path = "/changed"
  }, TypeError)
  assert.ok(ADMIN_HTTP_METHODS.includes("PATCH"))
})

test("不支持的协议选项、字段拼写和含糊路径参数立即拒绝", () => {
  for (const options of [
    null,
    { method: "get", path: "/x" },
    { method: "OPTIONS", path: "/x" },
    { method: "POST", path: "/x", responseMode: "sse" },
    { method: "POST", path: "/x", reponseMode: "json" },
    { method: "GET", path: "/x", inputSource: "body" },
    { method: "GET", path: "/users/:id" },
  ]) {
    assert.throws(
      () => httpBinding(options),
      (error) => error.code === "invalid-definition",
    )
  }
  assert.equal(
    httpBinding({ method: "GET", path: "/users/:id", inputSource: "request" }).inputSource,
    "request",
  )
})

test("拒绝 URL、空段、编码绕行、点段和不合法参数名", () => {
  for (const path of [
    "x",
    "https://example.com/x",
    "//",
    "/a//b",
    "/a/../b",
    "/x?query=1",
    "/x#fragment",
    "/a/%2e%2e",
    "/a/*",
    "/a\\b",
    "/:x/:x",
    "/:__proto__",
  ]) {
    assert.throws(() => httpBinding({ method: "GET", path, inputSource: "request" }))
  }
})
