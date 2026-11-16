# toy-model-support

LLM/JEV 结构化分类调用的公共基类。业务分析包继承 `LlmSupport`、`JevSupport` 或 `QuestionSupport`，
只描述领域输入校验、Prompt 和输出 Schema。

- `LlmSupport`：`ctx.llm.generate` + JSON Schema 输出 + Zod 二次校验；config 必须提供 `provider` 和 `model`。
- `JevSupport`：`ctx.jev.invoke` 的 choice/score/noul 答案投影为扁平业务结果。
- `QuestionSupport`：单问题，strategy 可在 LLM/JEV 之间切换（默认 llm，config 必须提供 provider/model）。

先加载 `toy-llm`（或 `toy-jev`），再加载继承这些基类的业务插件。
