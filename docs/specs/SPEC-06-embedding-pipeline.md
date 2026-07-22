# SPEC-06 — Embedding 管线 v1.0

> 状态：✅ **Done（2026-07-19，十条 AC 全绿）**。RAG 弧线第三步。前置 SPEC-05 Done。
> **2026-07-18 修订（Control/12 待吸收清单 ①–④ 落笔，Max 已裁决）**：FR-2 原子共部署、FR-4 分批循环、FR-5 尾调仅限 webhook 模式、AC-8 同日相邻前后对。
> **2026-07-19 实施备注**：AC-8 跨日成立——经语料同一性验证（thoughts/chunks 零变动）后裁决“同日规则的实质是语料同一性”，前照 07-18 / 后照 07-19，30/30 逐位一致。AC-6 经授权临时绕 set_chunks_updated_at 修正测法（触发器已验证恢复）。实施中顺带修复 SPEC-08 遗留的 compute_thought_content_hash 缺授权（service_role，迁移 20260719235835），digest 静默失败据此并案。NFR-3 实测：全量重建 26 次调用、约 3k tokens、成本远低于 1 美分——“敢清列重建”已有实测底气。收账细目见 12_RAG 弧线实施前审计 — 存档 SPEC-06 段。
> 吸收修复表条目：#9 前半（向量落库；检索切换在 SPEC-07）。
> 网关决策（2026-07-06，Max）：**平行函数 call-embedding**，不并入 call-llm——两网关职责不交叉（completion 归 call-llm，embedding 归 call-embedding），各自契约干净。
> 吸收脑暴槽位：槽2（call-embedding 唯一出口 + embedding_model 逐行落库），见 [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md) §2。
> 设计基调：**本 spec 是 SPEC-03 状态机模式的第一次复用**——状态机、卡死救援、backfill、预算闸门、乐观锁，全套骨架原样平移。
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：pgvector 扩展启用；chunks 长出 embedding 列及配套状态机；call-embedding 成为全系统唯一 embedding 出口；存量全量回填完成。**本 spec 关闭时检索行为零变化**——向量在库里悄悄长出来，线上读路径一根手指不动（风险隔离：embedding 管线任何问题都不影响现役检索）。

**非目标**（v1 不做）：
- 检索切换（SPEC-07）
- ANN 索引（决策见开放问题 1——v1 精确扫描）
- 领域微调 embedding（理论底稿的"语义坍缩"对策，个人语料量级无此病）
- Batch API 分支（M-5 触发条件不变：月账单超 $5 或首次大规模离线作业）
- query embedding 缓存
- 第二 embedding 提供商分支（见延期项——与当年 call-llm 双分支的决策情形不同，理由见表内）

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | 迁移：`CREATE EXTENSION IF NOT EXISTS vector`；chunks 加列 `embedding vector(1536)`、`embedding_model text`、`embedding_status text NOT NULL DEFAULT 'pending'`（枚举 pending / retrying / done / failed）、`embedded_at timestamptz`、`embedding_error text` |
| FR-2 | MUST | 预算计数表泛化：llm_daily_usage 加 `kind text NOT NULL DEFAULT 'llm'`，主键改 `(day, kind)`，存量行自动 kind='llm'。阈值分列：LLM_DAILY_BUDGET（200，不变）与 EMBEDDING_DAILY_BUDGET（默认 500，**按 API 调用次数计，一次批量 = 1 次**）。**⚠ 原子共部署（Control/12 G-1）**：本迁移使 call-llm 现役 `ON CONFLICT (day)` upsert 立即失效——call-llm 的 upsert MUST 同批改为 `ON CONFLICT (day, kind)`（kind='llm'），迁移与 call-llm 重部署绑进同一部署步骤，never 存在旧 upsert 还在跑的窗口；部署后即刻实测一次预算累加 |
| FR-3 | MUST | 新 edge function `call-embedding`：POST，验 `Bearer {AGENT_ACCESS_KEY}`；入 `{ texts: string[], model?: string }`——texts 1–100 条、单条 ≤ 6000 字符，超限 400；出 200 `{ embeddings: number[][], model, dimensions }`。**先计数后调用**（原子 upsert，语义与 SPEC-03 NFR-1 逐字一致，kind='embedding'），超额 429。提供商 v1 仅 openai（POST api.openai.com/v1/embeddings），模型 = EMBEDDING_MODEL 环境变量（默认 text-embedding-3-small）；key 缺失 → 502 恒定错误体；上游非 2xx → 502 摘要错误，never 透传可能含 key 的原始内容 |
| FR-4 | MUST | 新 edge function `embed-chunks` 双模式：**document 模式**（Authorization + `{ thought_id }`：取该文档全部 embedding_status='pending' 的 chunks，置 retrying，按 **≤ 100 texts 分批循环**调 call-embedding（每批计 1 次预算；Control/12 G-7：单次批量在 > 100 chunks 的文档上必 400，是回填救不了的确定性死路），逐批写回向量 + embedding_model + embedded_at + status='done'；任一批失败 → 尚未写回的行落 failed + embedding_error，已写回批次保留 done（回填只捞 pending/failed，天然断点续传），never 留 retrying）+ **backfill 模式**（Authorization + `{mode:"backfill"}`：扫全表 `pending / failed` 外加尸体救援 `retrying AND updated_at < now() - interval '1 hour'`；逐文档乐观锁抢行；命中 429 优雅停止，已抢行落回 failed，never 留 retrying） |
| FR-5 | MUST | 触发链：chunk-thought 完成原子替换后**尾调** embed-chunks（document 模式，fire-and-forget——尾调失败不影响切块结果，回填兜底）。**尾调仅限 webhook 模式（Control/12 G-8 附带裁决，2026-07-18）**：chunk-thought 的 backfill 模式不尾调——批量重切产生的 pending 交每日 embedding backfill 消化（cron 天然削峰不冲预算；期间文档在 keyword 腿仍可见，符合降级哲学）；pg_cron 每日调 backfill（可并入现有 enrich-backfill-daily 的时段，独立 job，凭据走 Vault 引用） |
| FR-6 | MUST | **换模型 = 改环境变量**：backfill 抓取条件额外包含 `embedding_status='done' AND embedding_model IS DISTINCT FROM 当前 EMBEDDING_MODEL` 的行——改 EMBEDDING_MODEL 后，回填自动识别全库"旧模型行"并重嵌，零代码（INV-8 同款哲学的 embedding 版）。**注意**：换到不同维度的模型 = embedding 列类型迁移，属于计划内 breaking 变更，届时立独立迁移，never 热切 |
| FR-7 | SHOULD | embed-chunks 出参 `{ embedded, failed, skipped }` |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 预算闸门语义与 SPEC-03 NFR-1 完全一致：原子 upsert、先计数后调用、失败 never 退还额度 |
| NFR-2 | MUST | 单文档（≤ 50 chunks）端到端 embedding < 30 秒 |
| NFR-3 | SHOULD | 成本量级落档备查：text-embedding-3-small ≈ $0.02 / 百万 token；当前全库量级的**全量重建成本在数美分内**——"敢清列重建"（INV-2）的底气要有数字支撑，实施时以真实库量算一遍记录在派活单收账 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | **embedding 唯一出口 = call-embedding**：任何函数 never 直连提供商 embedding API。与 call-llm 的 INV-1 平行且相互独立：call-llm never 出 embedding，call-embedding never 出 completion——两网关职责不交叉 |
| INV-2 | **embedding 是派生数据、重建安全**：清空全列 + 回填重建的全过程 MUST 不触碰 thoughts.content、chunks.content 及任何元数据（AC-4 硬验证，不是口头承诺） |
| INV-3 | 每行向量 MUST 带 embedding_model 标记——never 存在"有向量、无模型标记"的行（没有标记的向量在换模型时无法识别，等于污染） |
| INV-4 | 状态机无死路（SPEC-03 INV-9 同款）：任何失败路径显式落 failed + embedding_error，never 留 retrying 退出 |
| INV-5 | 认证 + key 纪律 + cron 凭据 Vault 引用，全套继承；AGENT_ACCESS_KEY 复用（同属 agent 自动化凭据类，三类凭据隔离原则不破，见开放问题 3） |
| INV-6 | call-embedding 的日志 never 记录 texts 正文——大脑内容不进函数日志（日志保留期与访问面都不受 SPEC-00 权限体系管辖，正文进日志 = 旁路泄露面） |
| INV-7 | 检索读路径本 spec 零改动（AC-8 以 eval 数字验证，不靠代码审查口头保证） |

## 5. 接口契约

**call-embedding**（POST，内部调用）
- 入：Authorization 头 + `{ texts: string[], model?: string }`
- 出：200 `{ embeddings, model, dimensions }` / 400（条数或单条长度超限）/ 401 / 429 `{ error: "daily budget exceeded", count }` / 502 `{ error }`

**embed-chunks**（POST，双模式）
- document 模式：Authorization + `{ thought_id: uuid }` → 200 `{ embedded, failed, skipped }`
- backfill 模式：Authorization + `{ mode: "backfill" }` → 200 `{ embedded, failed, skipped }`

**环境变量**：
| 变量 | 默认 | 说明 |
|---|---|---|
| EMBEDDING_MODEL | text-embedding-3-small | 换模型入口（FR-6）；换不同维度模型走独立迁移 |
| EMBEDDING_DAILY_BUDGET | 500 | 按 API 调用次数计（批量 = 1 次） |

迁移文件沿用编号；部署一律 `--no-verify-jwt`。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 插入一条新想法（会切成多 chunk 的长度） | 60 秒内该文档全部 chunks embedding_status='done'、向量非空、embedding_model = 当前配置值 |
| AC-2 | **负路径**：call-embedding 无认证头；texts 传 110 条 | 分别 401（零上游调用）与 400 |
| AC-3 | 预算闸门：EMBEDDING_DAILY_BUDGET 临时设 1，连发两次 call-embedding | 第二次 429（验完改回） |
| AC-4 | **重建安全实测**（INV-2 的硬验证）：记录全表 chunks.content_hash 集合 → `UPDATE chunks SET embedding=NULL, embedding_status='pending'` → 跑 backfill → 比对 | 全部回到 done；content_hash 集合逐字节一致；thoughts 表零变更 |
| AC-5 | 换模型识别（FR-6）：手工把某行 embedding_model 改成假值 'stale-model' → 跑 backfill | 该行被捞起重嵌，embedding_model 恢复为当前配置值 |
| AC-6 | 尸体救援：手工造一行 retrying + updated_at 倒填 2 小时 → 跑 backfill | 被捞起并落终态（done 或 failed + embedding_error），不再 retrying |
| AC-7 | 存量回填完成后查询 | 无 pending / 无无错误信息的 failed（failed 行 MUST embedding_error 非空可定位） |
| AC-8 | **检索零变化（同日相邻前后对，Control/12）**：收账当日先在现役系统跑一次前照 run，SPEC-06 全部完成后同日再跑一次，两 run 之间冻结新捕获；实现标识均 "chunked-ilike"（若实施跨多日，前照 run 放在收账当天早上，冻结窗口最短） | 相邻两 run 指标**逐位一致**——读路径未动的数字证明。never 与 SPEC-05 收账存档对比（语料已漂移，远期对比必然假失败） |
| AC-9 | 抽查 call-embedding / embed-chunks 函数日志 | 无 texts 正文、无任何 key 值 |
| AC-10 | 仓库 grep 各 key 实际值 | 零匹配 |

## 7. 顺序与延期项

**顺序**：迁移（extension + 列 + 计数表泛化）→ call-embedding（AC-2/3）→ embed-chunks document 模式 + 尾调触发链（AC-1）→ backfill 模式 + cron + 存量回填（AC-6/7）→ 重建与换模型演练（AC-4/5）→ 检索零变化回归（AC-8）→ 收尾（AC-9/10）。

**延期项**：
| 项 | 触发条件 |
|----|----------|
| ANN 索引（HNSW） | chunks > 10,000 行，或检索 P95 > 1 秒。届时注意 filtered ANN 的召回细节（filter 与 HNSW 遍历的交互） |
| Batch API 分支 | M-5 原触发条件（月账单 > $5 或大规模离线作业）；全量重嵌是天然适用场景 |
| 第二 embedding 提供商 | 真实切换需求出现时。**与当年 call-llm 预留双分支的决策情形不同**：completion 换提供商零迁移成本，embedding 换提供商 = 必然全量重建（向量空间不可混用），预留分支省不掉重建这个大头，预留价值低 |
| query embedding 短时缓存 | SPEC-07 后同 query 重复率可观测且可观时 |

## 8. 开放问题

- [x] v1 是否建 ANN 索引 —— **已决策：不建**。当前量级精确扫描毫秒级完成且结果精确（检索层 recall=100%，eval 数字不掺索引近似误差——SPEC-07 的对比才干净）；HNSW 在小表上是纯复杂度与内存成本。触发条件见延期项。
- [x] embedding 预算与 LLM 预算同池还是分池 —— **已决策：分池（kind 列）**。embedding 单价低 completion 两个数量级，同池会出现"一次回填风暴吃光当日 enrichment 额度"的跨系统耦合——闸门本该隔离故障，不该传导故障。
- [x] call-embedding 凭据 —— **已决策：复用 AGENT_ACCESS_KEY**。它与 call-llm / enrich-thought / weekly-digest 同属"agent 自动化"凭据类，三类凭据（CAPTURE / MCP / AGENT）互不复用的隔离原则不破。Max 有异议可在派活前改为独立 key，成本为零。

---

[SPEC-05 分表与 Chunking](SPEC-05-chunking.md) · [SPEC-07 Hybrid 检索切换](SPEC-07-hybrid-search.md) · [SPEC-03 自动化代理与 LLM 网关](SPEC-03-agents-llm-gateway.md) · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) · [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md)
