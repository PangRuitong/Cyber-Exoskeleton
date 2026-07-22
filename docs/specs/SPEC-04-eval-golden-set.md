# SPEC-04 — 评估基建：Golden Set 与检索指标 v1.0

> 状态：✅ Done（2026-07-16，全部 AC 通过，基线已落档）。RAG 弧线第一步（04 → 05 → 06 → 07，依赖线性）。
> **基线数字（ilike-baseline，2026-07-16，存档 eval/runs/2026-07-16-baseline-1.json）**：总体 recall@10 = 0.333（id 级 13/39），MRR = 0.4。分层：A = 1.0（全部第 1 位命中）、B = 0、C = 0。C 层全灭揭示 ilike 整句子串匹配连分词能力都没有——升级动机的量化：系统对 60% 的真实查询意图召回为零。INV-4 已满足，SPEC-05 放行。
> **SPEC-07 收官数字（hybrid-rrf，2026-07-20，存档 eval/runs/2026-07-20-spec07-hybrid.json）**：按不同 thought rank 计量，总体 recall@10 = 0.9487（37/39），MRR = 0.9611；A = 1.0，B = 1.0（严格高于基线 0），C = 0.8571；中文 = 0.9259，英文 = 1.0。评测期间语料冻结为 30 thoughts / 40 chunks，未出现 degraded；10 次连续查询 P95 = 1244 ms（< 1500 ms）。
> **为什么必须先行**：ilike 基线只在被替换之前可测。错过这个窗口，整条 RAG 升级弧线就永远只有"感觉变好了"，没有前后对比的数字——时序不可逆（INV-4）。
> 理论底稿：评估基础设施 — 最小要搭哪几件。本 spec 是其 MVP 段落（20–50 条 golden set + recall@k）在本项目的落地。
> 吸收修复表条目：无（自立项）；为修复表 #9 的验收提供仪器。
> 关键词等级：MUST / SHOULD / MAY（RFC 2119）

---

## 1. 目标与非目标

**目标**：一套人工核定的 golden set + 一个可重复运行的检索评估脚本，经**真实 MCP 检索接口**（不绕过接口直查 DB——测的是系统对外的真实行为）测 recall@10 与 MRR，并把当前 ilike 系统的基线数字落档。

**非目标**（v1 不做）：
- 生成质量评估（faithfulness / LLM-as-judge）——v1 只测检索层，零 LLM 成本、确定性、每次改动都跑得起。检索/生成分开测的理由见理论底稿 §2
- CI 集成（触发条件：检索实现发生第二次变更时）
- 从可观测数据自动生长 golden set（观测→用例的飞轮，触发条件：SPEC-07 上线后出现第一个真实检索失败案例）
- golden set 管理界面（JSON 文件 + git 即够）
- nDCG（触发条件：rerank 上线时，排序质量才值得精测）

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | golden set 为仓库内 JSON 文件 `eval/golden_set.json`。条目 schema：`{ id: string, query: string, expected_thought_ids: uuid[], stratum: "A"\|"B"\|"C", lang: "zh"\|"en", notes?: string, added: date }` |
| FR-2 | MUST | 规模 ≥ 30 条且逐条人工核定。分层配额：**A 关键词直中**（query 词面出现在目标内容中，ilike 应命中）≥ 10；**B 语义改写**（同义/意译，ilike 预期失败——"推广产品"搜 marketing 类）≥ 10；**C 多文档综合**（expected 含 ≥ 2 个 thought）≥ 5。**中文 query ≥ 8 条**（真实使用是双语的，且中文是 SPEC-07 keyword 腿技术选型的裁决数据，见该 spec 开放问题） |
| FR-3 | MUST | 评估脚本 `eval/run_eval.ts`（Deno/TypeScript，与项目栈同构）：逐条以 JSON-RPC tools/call 调 MCP 端点的 search_thoughts；MCP_ACCESS_KEY 从环境变量读取 |
| FR-4 | MUST | 指标：recall@10（分层 + 总体）与 MRR。**命中判定锚 thought 级**：返回结果含 chunk 时（SPEC-05 后），以其 parent thought_id 归属后再比对 expected（INV-2 的执行面） |
| FR-5 | MUST | 每次运行产出不可变存档 `eval/runs/{date}-{label}.json`：时间戳、git commit hash、检索实现标识（如 "ilike-baseline" / "chunked-ilike" / "hybrid-rrf"）、逐条命中明细（每条 query 返回了哪些 id、命中哪些）、汇总指标 |
| FR-6 | SHOULD | 逐条记录查询延迟（纯观察值，不设阈值——为 SPEC-07 NFR 提供参照系） |
| FR-7 | MAY | `--stratum A\|B\|C` 跑子集 |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 零写入：脚本只调只读检索工具，对生产表零 INSERT/UPDATE/DELETE，零 schema 触碰 |
| NFR-2 | MUST | 零 LLM、零 embedding 成本（recall/MRR 是确定性计算） |
| NFR-3 | MUST | 确定性：同一库状态、同一检索实现下连续两次运行，指标逐位一致 |
| NFR-4 | SHOULD | 全量运行 < 5 分钟 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | golden set 条目 never 由 LLM 批量生成后免审入库——每条经 Max 人工核定。真值集的定义就是"人核定过"；LLM 可起草候选，核定权 never 下放（起草流程见开放问题 2） |
| INV-2 | 真值锚 thought 级，never 锚 chunk 级——SPEC-05 分表后真值集零作废（chunk 是易变的派生物，thought 是稳定的事实源） |
| INV-3 | harness 对生产库零写入（NFR-1 升格为不变量：未来任何人给脚本加功能都受此约束） |
| INV-4 | **基线数字 MUST 在 SPEC-05 动工前落档**——时序不可逆，错过即永久丢失。SPEC-05 的派活单 MUST 以本条为前置检查项 |
| INV-5 | MCP_ACCESS_KEY 只从环境变量读，never 出现在脚本、golden set、run 存档、仓库任何位置 |
| INV-6 | run 存档 never 事后修改——数字错了重跑出新档，旧档保留（存档的可信度来自不可变性） |

## 5. 接口契约

**golden_set.json 条目示例**：
```json
{
  "id": "gs-007",
  "query": "怎么防止 LLM 输出没过校验就写进数据库",
  "expected_thought_ids": ["<uuid>"],
  "stratum": "B",
  "lang": "zh",
  "notes": "目标 thought 原文用的是'输出过闸'措辞，词面不重合",
  "added": "2026-07-07"
}
```

**run 存档骨架**：
```json
{
  "ran_at": "...", "git_commit": "...", "retrieval_impl": "ilike-baseline",
  "baseline": true,
  "summary": { "recall_at_10": {"overall": 0.0, "A": 0.0, "B": 0.0, "C": 0.0, "zh": 0.0, "en": 0.0}, "mrr": 0.0 },
  "details": [ { "id": "gs-007", "returned_ids": [], "hits": [], "latency_ms": 0 } ]
}
```

**调用路径**：生产 MCP 端点 POST /functions/v1/open-brain-mcp（JSON-RPC tools/call → search_thoughts）。端点封装收口在脚本内单一 client 函数——未来工具改名/换端点只改一处。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 审 golden_set.json | ≥ 30 条；A ≥ 10 / B ≥ 10 / C ≥ 5；zh ≥ 8；文件头部记录核定日期与核定人（Max） |
| AC-2 | 全量运行 | 产出 run 存档，含逐条明细与分层汇总，git commit 与实现标识非空 |
| AC-3 | 连续运行两次 | 指标逐位一致（NFR-3） |
| AC-4 | **基线落档**：在当前（未分表、ilike）系统上运行，存档标记 baseline=true | 分层 recall 可见；**预期 B 层显著低于 A 层**——这正是整条升级弧线动机的量化，数字不好看是本次运行的成功而非失败 |
| AC-5 | **负路径**：错误 MCP key / 断网运行 | 脚本明确报错非零退出，never 产出半截存档 |
| AC-6 | 仓库 grep MCP_ACCESS_KEY 实际值 | 零匹配 |

## 7. 顺序与延期项

**顺序**：条目 schema 定稿 → Claude 起草候选条目（读现有捕获，配对 query）→ Max 逐条核定删改（INV-1）→ runner 实现 → AC-3 确定性验证 → **基线运行落档（AC-4，SPEC-05 的放行闸）**。

**延期项**：
| 项 | 触发条件 |
|----|----------|
| faithfulness / LLM-as-judge | SPEC-07 后对生成侧质量产生怀疑时 |
| CI 集成（改动自动跑回归） | 检索实现第二次变更 |
| 观测→golden set 飞轮（真实失败查询转用例） | SPEC-07 后首个真实检索失败案例 |
| nDCG | rerank 上线 |
| golden set 定期养护节奏 | 条目老化（expected 内容被大量新捕获稀释）首次被观察到 |

## 8. 开放问题

- [x] 起始规模 30 vs 50 —— **已决策：30 起步**。理论底稿的原话是"建与养是最难最贵的部分、从真实失败里长大"——养大于建，起步够用即可，SPEC-07 后飞轮接管生长。
- [x] 候选起草方式 —— **已决策：Claude 起草候选对（读库内真实捕获，构造 A/B/C 三层 query），Max 逐条核定删改**。效率与 INV-1 兼容：起草不是核定，入库前每条过人眼。
- [x] B 层 query 的"改写距离"如何把握：首轮核定（07-15）30 条实践验证了"Max 能想起但 Ctrl+F 找不到"经验法则可操作，暂不需成文。跨语言对（中文 query → 英文捕获）占 B 层 4/12，是向量腿的真实考验项。

---

[SPEC-05 分表与 Chunking](SPEC-05-chunking.md) · 评估基础设施 — 最小要搭哪几件 · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) · [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md)
