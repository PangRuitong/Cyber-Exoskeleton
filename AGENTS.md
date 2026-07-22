# Open Brain (Cyber Exoskeleton)

个人 AI 知识库：Supabase（数据库 + edge functions）+ Vercel（前端）+
MCP server（接 Codex Desktop）+ 自动化 agents。Fork 自
King-Tuerto/open-brain-student，按 docs/specs/ 下的规格逐步改造。

## 前置依赖（所有 spec 的地基）

各 SPEC 以课程 Level 0–2 的产出为地基；其中 RAG 弧线 SPEC-04→05→06→07 依赖线性，SPEC-04（评估基建）必须最先完成，时序不可逆。地基未完成前不执行任何 spec 任务。

**必须存在的产出物：** Level 0–2 各级的完成判定以 docs/STATUS.md 中对应项的验证方式为准。

**规则：**

- 每次会话开始先读 `docs/STATUS.md`，确认当前起点再接受任何任务。
- 如收到 SPEC 任务但前置项未完成，停下来列出缺少的具体产出物，不执行。

## 工作规则（每次任务都适用）

1. **Spec 驱动。** 动任何代码之前，先完整阅读本次任务对应的 spec
   （路由见下表）。没有对应 spec 的改动，先停下来向我确认。
2. **INV 不可协商。** 各 spec 第 4 节的不变量在任何实现路径下必须成立。
   如果某个实现方案会违反 INV，不要变通绕过——停下来报告冲突。
3. **完成的定义 = AC 通过。** 任务指定的验收标准全部可演示通过才算完成。
   只测成功路径不算完成——AC 里的负路径（401、坏输入、空输入）同样必须验证。
4. **一次只做派给你的那一步。** 不要顺手重构、不要超出本次任务范围扩展功能。
   发现范围外的问题：记录并报告，不要直接修。
5. **歧义必须上浮。** 遇到 spec 没覆盖的设计决策，明确提出问题让我选择，
   不要静默选一个默认值。
6. **机密纪律。** 任何 API key、token、密码 never 写入仓库内任何文件。
   机密只存在于 Supabase Secrets。每次提交前确认 grep 不到机密值。

## Spec 路由表

| 任务涉及 | 必读 spec |
| --- | --- |
| Supabase 项目创建、访问控制、RLS 策略、fail-closed 开关、项目底座 | docs/specs/SPEC-00-project-foundation.md |
| Discord bot、Siri/quick-capture、任何捕获入口 | docs/specs/SPEC-01-capture-channels.md |
| MCP server（open-brain-mcp 函数）、Codex Desktop 接入 | docs/specs/SPEC-02-mcp-server.md |
| call-llm、enrich-thought、weekly-digest、pg_cron、任何 LLM 调用 | docs/specs/SPEC-03-agents-llm-gateway.md |
| 评估基建、golden set、Recall@10 / MRR、检索质量度量 | docs/specs/SPEC-04-eval-golden-set.md |
| chunking、分表、chunks 表、原子替换、chunk 相关 schema | docs/specs/SPEC-05-chunking.md |
| embedding、call-embedding、embed-chunks、pgvector、向量落库 | docs/specs/SPEC-06-embedding-pipeline.md |
| hybrid 检索、vector / keyword 腿、RRF、rerank、filter 下推 | docs/specs/SPEC-07-hybrid-search.md |
| 捕获去重、content_hash、幂等、Discord 错误回执 | docs/specs/SPEC-08-error-receipts-idempotency.md |
| 前端（index.html）、其余无专属 spec 的 DB schema | 暂无专属 spec——动之前先确认；schema 相关改动先看 SPEC-00 / 05 / 06 |

跨多个区域的任务：读全部相关 spec。SPEC-03 的 INV-1（所有 LLM 调用
必须经 call-llm 网关）对全仓库生效，不限于 SPEC-03 范围的任务。

## 工程教义（跨 spec 通用，写码 / 立 spec 前先读）

- 立任何新 spec、做设计评审前：`docs/engineering/design-pressure-test.md`（D-1…D-9 设计压力测试）
- 动检索层（K 值、腿、rerank、embedding 模型、chunk 参数）前：`docs/engineering/rag-operations-doctrine.md`（RAG 是活系统，含触发条件表）
- 排查已知隐患 / 安全债：`docs/engineering/edge-cases-and-fixes.md`（P0/P1/P2 修复表）
- 设计 agent 类工作流前：`docs/engineering/agent-era-design-constraints.md`（大脑只读、不可逆动作 never 自动执行、检索内容 never 触发工具）

## 目录约定

- docs/specs/ — 权威执行文档（中文）。docs/curriculum/ — 课程原文，
  只读参考；与 spec 冲突时以 spec 为准。
- supabase/functions/{name}/index.ts — 每个 edge function 一个文件夹
- supabase/migrations/ — 编号迁移（001*、002*…），schema 改动必须走迁移文件，
  不直接在 SQL Editor 手改后不留痕

## 常用命令

- 部署函数：supabase functions deploy {name} --project-ref $PROJECT_REF
  （Discord bot 需加 --no-verify-jwt，原因见 SPEC-01）
- 查函数日志：supabase functions logs {name} --project-ref $PROJECT_REF
- 本地起前端：直接开 index.html 或 npx serve .

## 技术约束备忘

- Edge functions 是 Deno 运行时（不是 Node）：用 Deno.env.get、
  内置 fetch、npm 包需 npm: 前缀导入
- Discord interaction 有 3 秒应答窗口——任何调 LLM 的命令必须走
  deferred（type 5 + followup），规则在 SPEC-01 NFR-1
- Supabase webhook 调用方收到非 200 会重试——webhook 类函数永远返回 200，
  失败写日志和 status 列（SPEC-03 INV-7）
