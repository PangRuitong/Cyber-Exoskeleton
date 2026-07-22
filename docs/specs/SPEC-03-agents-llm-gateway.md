# SPEC-03 — 自动化代理与 LLM 网关 v1.0

> 状态：✅ Done（2026-07-06，全部 12 条 AC 通过，派活单：HANDOFF 2026-07-06 — SPEC-03 派活单，已完结留档）
> 实施中落地的设计升级与决策（以此为准，优先于正文相应段落）：
> 1. **webhook 模式不豁免认证**：触发器从 Vault 读 AGENT_ACCESS_KEY 随请求携带，三函数认证覆盖 100%（强于正文 INV-2 的豁免设计）
> 2. **digest 行权威标记 = source 列**：enrich-thought 置 skipped 时清空 category；任何排除 digest 的查询 MUST 以 source='digest' 为准，never 依赖 category
> 3. **OpenAI 分支 GPT-5 系列适配**：max_completion_tokens（非 max_tokens）、不传 temperature、可选 LLM_REASONING_EFFORT 环境变量（不设 = 模型默认 none，当前选择）
> 4. **新增 DIGEST_MIN_ROWS 环境变量**（默认 5），供 FR-6 阈值调节与 AC-8 类测试
> 当前生产配置：LLM_PROVIDER=openai · LLM_MODEL=gpt-5.4-mini · effort 默认 none · LLM_DAILY_BUDGET=200
> 对应课程：06_Level-5 自动化代理
> 吸收修复表条目：#3（端点认证）、#6（enrichment 校验与回填）、#7（digest 自触发）、#8（成本闸门）、#12（时区）——本 spec 是修复表 P1 区的主要落地载体
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：三个 edge function——call-llm（网关）、enrich-thought（INSERT 触发的富化）、weekly-digest（cron 触发的周报）——使每条捕获自动获得 tags / category / summary，每周日产出学习摘要，且所有 LLM 调用经由单一可换提供商的出口。

**非目标**（v1 不做）：
- 邮件投递 digest（存回 thoughts 表即可，Discord /digest 命令是更顺手的查看方式，见延期项）
- 流式响应、多轮对话式 agent（全部是单发 prompt → 单个结构化结果）
- 自动重试风暴（失败标记 + 定时回填，不做指数退避的实时重试链）
- 跨提供商的功能对齐（网关契约取最大公约数：prompt 进、text 出）

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | call-llm 接受 {prompt, systemPrompt?, maxTokens?}，返回 {text}；提供商与模型由 LLM_PROVIDER / LLM_MODEL 环境变量决定 |
| FR-2 | MUST | enrich-thought 由 thoughts INSERT webhook 触发，产出 tags（3–5 个）、category（枚举：idea/learning/question/reference/plan/reflection/digest）、summary（≤ 1 句）并 UPDATE 回原行 |
| FR-3 | MUST | weekly-digest 汇总最近 7 天捕获，按 category 分组，生成主题总结 + 一个"正在探索的问题"，作为新行存入（category=digest） |
| FR-4 | MUST | enrichment 维护状态机：enrichment_status ∈ pending / retrying / done / failed / skipped |
| FR-5 | MUST | 每日回填：重试所有 failed 与超过 1 小时仍 pending 的行。实现为 enrich-thought 的 backfill 模式（同一函数双触发，零新端点）：pg_cron 每日调 {mode:"backfill"}，函数自扫表。拿行用条件更新做乐观锁（`UPDATE … SET enrichment_status='retrying' WHERE id=? AND enrichment_status IN ('failed','pending')`，抢不到即跳过），防与 webhook 实时处理竞态重复烧 LLM 调用；pending 超时判定落实为 SQL 条件 `created_at < now() - interval '1 hour'`。回填抓取条件 MUST 含卡死救援：`enrichment_status IN ('failed','pending') OR (enrichment_status = 'retrying' AND updated_at < now() - interval '1 hour')`——函数在置 retrying 后崩溃（超时/部署打断）的行超过 1 小时视为尸体，重新捞起，never 让 retrying 成为进得去出不来的状态 |
| FR-6 | SHOULD | digest 在内容不足（< 5 条）时跳过并留日志，不调用 LLM |
| FR-7 | MAY | call-llm 记录每次调用的 token 用量到一张 llm_usage 表 |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | **预算闸门**：call-llm 维护每日调用计数，超过阈值（初始 200 次/日）拒绝并返回明确错误（修复表 #8）。实现规格：计数器落单行表 `llm_daily_usage (day date PK, count int)`，函数开头一条原子 upsert（`INSERT … ON CONFLICT (day) DO UPDATE SET count = count + 1 RETURNING count`）完成计数+读回，Postgres 串行化免疫并发竞态（never 用先 SELECT 后 UPDATE 的两步写法）。**先计数后调用**：失败的 LLM 调用也占额度，never 退还——闸门防的失控循环往往正是"失败→重试"循环，失败不计数则闸门对最需拦的场景失明。200 的定位是保险丝非配额（正常峰值 7–10 倍，打满也仅几美分到几毛美元/日）；FR-7 落地后日计数可改为从明细表聚合，本表退役 |
| NFR-2 | MUST | digest cron 按 Phoenix 时间周日早 8 点 = 0 15 * * 0 UTC（修复表 #12；AZ 无夏令时，全年成立） |
| NFR-3 | SHOULD | 富化端到端（INSERT → 列填上）≤ 30 秒 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | **网关强制**：任何函数 never 直接调用 LLM 提供商 API；唯一例外是 call-llm 自身。新增 agent 默认违反此条直至证明经由网关 |
| INV-2 | **端点不裸奔**：call-llm / enrich-thought / weekly-digest 全部要求认证头；pg_cron 与 webhook 的调用配置必须携带凭据；凭据 never 明文写进 cron SQL（用 Vault 引用）（修复表 #3） |
| INV-3 | **LLM 输出过闸**：enrichment 结果在写库前 must 通过校验——剥除 markdown 围栏、tags 为非空数组、category 落在枚举内、summary 非空。任一失败 → status=failed，never 写入半成品字段（修复表 #6；FTHB finding_validator 同款原则的迷你版） |
| INV-4 | **不自吞**：enrich-thought 对 category=digest 的行直接 skipped；digest 的输出 never 再次进入富化（修复表 #7） |
| INV-5 | **幂等**：同一行被重复触发富化，结果一致且不产生重复副作用（UPDATE 语义天然幂等，回填任务依赖此条） |
| INV-6 | **去重**：内容 sha256 相同的行不重复调 LLM，直接复用已有富化结果（修复表 #8；FTHB enrichment cache 同款） |
| INV-7 | webhook 类函数对调用方 always 返回 200（即使内部失败），失败信息进日志与 status 列，never 让 Supabase webhook 进入重试风暴 |
| INV-8 | API key（ANTHROPIC_API_KEY 等）只存在于 Supabase Secrets；切换提供商的全部操作 = 改 LLM_PROVIDER + 加新 key，零代码改动 |
| INV-9 | **状态机无死路**：enrich-thought 的任何失败路径（catch 块、校验不过、预算闸门拒绝）MUST 显式将行落到 failed 或 skipped，never 让行停留在 retrying 退出函数。与 FR-5 的超时救援互为双保险 |

## 5. 接口契约

**call-llm**（POST，内部调用）
- 入：Authorization 头 + { prompt: string, systemPrompt?: string, maxTokens?: number }
- 出：200 { text } / 401 / 429 { error: "daily budget exceeded", count } / 502 { error }（上游提供商失败）

**enrich-thought**（POST，双触发）
- 模式 1 — webhook：Supabase webhook payload（record 含新行）；always 200；副作用为 UPDATE 行 + status 变更
- 模式 2 — backfill（仅由 pg_cron 每日调用）：Authorization 头 + { mode: "backfill" }；函数扫表处理全部可重试行，命中预算闸门时优雅停下留待次日；出 200 { retried: n, succeeded: n, failed: n }

**weekly-digest**（POST，仅由 pg_cron 调用）
- 入：Authorization 头 + 空体
- 出：200 { created: boolean, reason? }

**schema 迁移**：tags text[] / category text / summary text / enriched_at timestamptz / enrichment_status text NOT NULL DEFAULT 'pending'（任何不知情的写入路径插入的行自动进入回填视野，never 出现 NULL 状态的隐身行） / content_hash text GENERATED ALWAYS AS (encode(sha256(content::bytea), 'hex')) STORED（hash 归属权在数据库层，四个写入入口 discord / siri / mcp / web 零代码、不可能漂移，存量行自动补齐；INV-6 去重直接查此列） / error_message text（失败原因落库，不依赖短保留期的函数日志——FTHB run_manifest 同款哲学：status=failed 时 MUST 写入可定位的失败原因，status=done 时清空）；另建单行表 llm_daily_usage（day date PK, count int，预算闸门计数器，见 NFR-1）。**补充（2026-07-06 派活审查发现的缺口）**：thoughts 表现无 updated_at 列，而 FR-5 卡死救援与 AC-12 依赖它——迁移 MUST 加 `updated_at timestamptz NOT NULL DEFAULT now()` + BEFORE UPDATE 触发器自动刷新。前置依赖：source text 列已由 SPEC-01 的独立迁移先行落地（枚举 siri / discord / mcp / web / digest，content 零前缀）。迁移文件入仓库 supabase/migrations 并编号（FTHB 惯例）。

**成本习惯备忘**：订阅（Claude Pro/Max）与 API 是两套隔离计费——重 token 活（基于大脑检索写方案/写代码）尽量推到订阅侧在 Claude Code / Desktop 里做（MCP 取数，包月内免费）；API 侧（call-llm 背后的 key）只留给无人值守的自动化（enrichment / digest / backfill）。never 给系统加走 API 的 agent 去干订阅侧能干的交互式重活。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 经 call-llm 发一个固定 prompt（正确认证） | 200 + 非空 text |
| AC-2 | **负路径**：call-llm 无认证头 | 401，函数日志无上游调用 |
| AC-3 | 保存一条 ≥ 3 句的想法 | 30 秒内该行 tags/category/summary 填上，status=done |
| AC-4 | **负路径**：临时把 enrichment prompt 改坏使其返回非 JSON，保存新想法 | status=failed，三个富化列保持 null（无半成品），函数返回 200 |
| AC-5 | 手动跑回填任务 | AC-4 那行被重试；prompt 修好后变 done |
| AC-6 | 保存两条 content 完全相同的想法 | 第二条复用富化结果，llm 调用计数只 +1（看日志/用量表） |
| AC-7 | 手动 Invoke weekly-digest（库内有 ≥ 5 条近 7 天数据） | 新增 category=digest 行；**该行 status=skipped，未被富化** |
| AC-8 | 库内只有 < 5 条近 7 天数据时 Invoke digest | { created: false }，零 LLM 调用 |
| AC-9 | 把每日预算阈值临时调成 1，连发两次 call-llm | 第二次 429 |
| AC-10 | Secrets 里把 LLM_MODEL 换成另一个 Anthropic 模型，重跑 AC-1 | 生效且零代码改动（INV-8 的最小验证） |
| AC-11 | 检查 cron 定义 | 0 15 * * 0，且 SQL 内无明文 key |
| AC-12 | 手工 UPDATE 一行为 enrichment_status='retrying' 且 updated_at 倒填 2 小时前，跑回填 | 该行被捞起并最终落到 done 或 failed，不再停留在 retrying（FR-5 卡死救援 + INV-9 的验证） |

## 7. 顺序与延期项

**顺序**：迁移（schema + status + hash 列）→ call-llm + 预算闸门（AC-1/2/9/10）→ enrich-thought + 校验 + 去重（AC-3/4/6）→ webhook 配置（含 digest 跳过条件）→ 回填任务（AC-5）→ weekly-digest + cron（AC-7/8/11）。

**延期项**：
| 项 | 触发条件 |
|----|----------|
| Discord /digest 命令（按需出周报） | SPEC-01 与本 spec 均 Done 后，作为第一个跨 spec 功能 |
| ~~第二提供商分支（openai/本地）~~ | ~~真实出现切换需求时~~ **决策变更（2026-07-06，Max）**：v1 即预留 anthropic + openai 双分支，API key 以 placeholder 先行，提供商调查后择一充值。理由：分支成本极低，且调查结果未定 |
| token 用量表 + 月度成本报告 | 月度 API 账单首次超过 $5 时 |
| enrichment prompt 外置成文件（FTHB prompt_loader 模式） | 第三次修改分类口径时 |

## 8. 开放问题

- [x] ~~回填任务的实现位置~~ **已决策（2026-07-03）**：并进 enrich-thought 本体（webhook / backfill 双模式）。理由：零新端点（INV-2 守护面不增，本项目风险排序里"端点裸奔"是 P0 主题，用函数内分支的审美代价换掉一个端点是净赚）；富化的校验/去重/状态机逻辑天然只有一份不会漂移。并进 weekly-digest 的选项当场否决：频率对不上（回填每日、digest 每周）
- [x] ~~category 枚举要不要从一开始就外置~~ **已决策（2026-07-03）**：v1 硬编码在函数内（prompt 与校验各一份），维持原判。理由：外置的前提（存在不碰代码的修改者 + 高频口径变更）在本项目都不成立，且外置引入"配置与代码不同步"的新失败模式。触发条件不变（第三次改分类口径，与 prompt 外置同批）。**到时外置的形态：配置文件（JSON），never Postgres enum 类型**——枚举的两个消费者（prompt 拼接、校验函数）都在应用层，且 DB enum 改值需 ALTER TYPE、删值基本要重建，与"想改得更容易"的外置动机相悖；写入前已有校验层把关，DB 层约束冗余

---

[SPEC-02 MCP 服务器](SPEC-02-mcp-server.md) · [SPEC-01 Discord + Siri 捕获通道](SPEC-01-capture-channels.md) · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md)
