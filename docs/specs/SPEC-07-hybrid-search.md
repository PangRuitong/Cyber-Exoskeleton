# SPEC-07 — Hybrid 检索切换 v1.0

> 状态：✅ Done（2026-07-20，全部 AC 通过）。RAG 弧线收官。Hybrid run：overall recall@10 = 0.9487（37/39），MRR = 0.9611；A = 1.0，B = 1.0（基线 0），C = 0.8571；中文 = 0.9259，英文 = 1.0；10 次连续查询 P95 = 1244 ms。存档：`eval/runs/2026-07-20-spec07-hybrid.json`。**前置：SPEC-06 Done + SPEC-04 基线在档。**
> 吸收修复表条目：#9 后半（检索切换）。兑现 SPEC-02 延期项承诺："search 换 pgvector 混合检索，**接口契约不变**，纯内部实现替换"。
> 吸收脑暴槽位：槽3（filter 对象形状 + 下推同查），见 [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md) §2；rerank 槽位为 Retrieve vs Rerank — 双塔与单塔 的漏斗第二段预留插入点。
> **本 spec 的关闭标准是数字，不是手感**（INV-6）——整条弧线在 AC-1 闭环。
> **2026-07-20 修订（Control/12 待吸收清单 ⑤–⑩ 落笔，Max 裁决 ⑧ 选 (a)，Codex 复核 FR-2 流水线）**：FR-2 重构为「thought 级截断后再展开 chunk」（⑤ tie-break + ⑧a）；FR-4 删 doc_types（⑦）；FR-6 降级触发改兜底「非 200」（⑨）；AC-1 加降级前置 + thought 级计量口径（⑥ + Codex 第7点）；AC-2 判读口径、FR-3 凭据注记、§3 NFR 适用期、§7 回滚行、AC-1 排期规则（⑨⑩）。收账见 12_RAG 弧线实施前审计 — 存档 待吸收清单。
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：search_thoughts 内部实现切换为 **vector + keyword 双腿、RRF 融合** 的 hybrid 检索；metadata filter 对象下推同查；rerank 槽位落码（v1 恒等）；golden set 前后对比闭环；退役收账（SPEC-02 NFR-2 截断正式拆除）。

**非目标**（v1 不做）：
- rerank 实现（cross-encoder）——槽位留好，触发条件见延期项；自己的笔记原话："语料小、区分粗时加 rerank 是过度工程"
- 跨文档二跳检索（引用图）
- 查询改写 / HyDE / 多查询扩展
- 新 MCP 工具（工具集不变：search_thoughts / list_recent / add_thought）
- sensitivity 过滤字段（脑暴槽4，触发条件：首个非 thoughts 语料接入；filter 对象形状已为其留位）

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | 迁移：chunks 加 `tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED` + GIN 索引（'simple' 的选型理由见开放问题 2） |
| FR-2 | MUST | 新建 PostgreSQL 函数 `hybrid_search(p_query text, p_embedding vector, p_filters jsonb, p_candidate_k int DEFAULT 50, p_result_k int DEFAULT 10)`；`p_result_k` 表示最终入选的**不同 thought 数**，有效范围为 `1..10`。流水线及排序语义锁死如下：① **两腿取候选**：vector 腿仅查询 `embedding_status='done'` 的行，按 `embedding <=> p_embedding ASC, chunk_id ASC` 确定性排序，取 top `p_candidate_k`；keyword 腿仅查询满足 `tsv @@ plainto_tsquery('simple', p_query)` 的行，按 `ts_rank(tsv, plainto_tsquery('simple', p_query)) DESC, chunk_id ASC` 确定性排序，取 top `p_candidate_k`；`p_filters` 的全部条件 MUST 同时下推进入两腿的候选 WHERE，never 搜后再筛。② **chunk 级融合**：对两腿候选按 chunk 执行 RRF，`fused_score(c) = Σ_leg 1/(60 + rank_leg(c))`，`k=60` 为固定常数；只在某一腿出现的 chunk，另一腿贡献为 0。③ **thought 聚合**：按 `thought_id` 分组，`thought_score = MAX(fused_score)`；即该 thought 名下最高分 chunk 决定 thought 排序，chunk 数量不得累加放大 thought 得分。④ **thought 级确定性排序**：按 `thought_score DESC, thought_id ASC` 排序并赋予 `thought_rank`。⑤ **thought 级截断**：在展开 chunk 之前截取 top `p_result_k` 个不同 thought；`p_result_k` 的 cutoff 单位为 thought，不是 chunk，默认 `p_result_k=10` 即 recall@10 的 10 个 thought 召回机会。⑥ **展开上下文**：每个入选 thought 返回最多 2 个最高分候选 chunk，组内按 `fused_score DESC, chunk_index ASC, chunk_id ASC` 确定性排序。⑦ **返回与排名纪律**：同一 thought 的第二个 chunk 继承相同 `thought_rank`，不占用新的 thought rank；最终条目上限为 `2 × p_result_k`，因此最多 20 条；每条返回 `fused_score`、`vector_rank`、`keyword_rank` 与 `thought_rank`，供日志和 eval 使用。**本条 supersede SPEC-05 FR-6 的「总条数 ≤ 10」，继承其「同一 thought ≤ 2 chunk」。Eval 的 recall@10 与 MRR MUST 按 `thought_rank` 计算，同一 thought 的后续 chunk不得重复计数。** |
| FR-3 | MUST | MCP search_thoughts 新流程：query → call-embedding（单条，经网关，INV 继承）→ RPC hybrid_search → INV-3 包裹返回。**接口向后兼容**：不带 filters 的旧式调用行为等价于全库检索（AC-4）。**凭据注记（低危台账）：自本 spec 起 MCP 函数持 AGENT_ACCESS_KEY 调 call-embedding——属内部调用非凭据复用，三类凭据（CAPTURE/MCP/AGENT）隔离不破；「MCP 函数同时持两类凭据」在此明说一句，免未来审计自惊。** |
| FR-4 | MUST | **filters 对象**（脑暴槽3）：可选入参 `{ sources?: string[], categories?: string[], created_after?: ISO8601, created_before?: ISO8601 }`——键间 AND、数组内 IN；**（G-6：v1 删 `doc_types` 键——该列要到槽4「首个非 thoughts 语料」才存在，提前声明一个无承重列的 filter 键 = 带该键查时要么报错要么静默不过滤，后者正是 INV-4 要杀的「以为过滤了实际没过滤」；槽位纪律是到时加字段，never 提前声明）**；**未知键 → JSON-RPC 参数错误（-32602），never 静默忽略**（静默忽略在权限型过滤场景 = 以为过滤了实际没过滤的泄露形态，习惯从第一天养对）；filter 条件 MUST 进入 hybrid_search 的 WHERE，与两腿相似度计算**同查下推**（filtered exact scan——形状即 filtered ANN 的正确姿势，理论底稿 pre-filtering 的落地） |
| FR-5 | MUST | **rerank 槽位**：hybrid 流水线中候选集显式流经 `rerankHook(query, candidates) → candidates`，v1 恒等实现。插入点：RRF 融合后、thought 分组前（作用于 chunk 级候选集——cross-encoder 天然按 query-chunk 配对打分，重排后经 `thought_score=max()` 自然传导到 thought 排序）。签名与位置写死在代码注释与本条——未来 cross-encoder 插这里，上下游零改动 |
| FR-6 | MUST | **降级路径**：call-embedding **任何非 200**（502/429/超时，**外加超长 query 的 400**——低危台账：400 不在原枚举内，改兜底式「非 200 即降级」堵掉这个缺口）→ 单腿 keyword 检索照常返回，结果头部标注 `[degraded: keyword-only]`，never 整体 5xx——检索可用性 > 检索完备性；降级事件落函数日志 |
| FR-7 | SHOULD | 每次检索在函数日志记录：query 长度（非正文）、两腿各自 top-5 的 chunk id 与名次、融合后 top-k id、是否降级——可观测层的最小形态，未来"观测→golden set 飞轮"的数据源（INV-6 日志纪律继承：never 记 query 与 chunk 正文） |
| FR-8 | MUST | **退役收账**：SPEC-02 NFR-2 的 2000 字符截断代码正式移除（CHUNK_MAX 即尺寸闸门）；返回条目的来源标注格式不变 |
| FR-9 | SHOULD | list_recent / add_thought 行为不变 |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 端到端（含 query embedding 网络往返）< 5 秒（SPEC-02 NFR-1 继承）；典型 < 1.5 秒 |
| NFR-2 | MUST | 查询侧 embedding 计入 EMBEDDING_DAILY_BUDGET，同闸门无豁免——检索被打爆同样烧钱，且 MCP 端点是三类凭据中暴露面最大的一个 |
| NFR-3 | MUST | 无新增固定成本（pgvector / tsvector 均为 Supabase 原生） |

> **eval harness NFR 适用期（低危台账，Control/12 ⑨）**：SPEC-04 NFR-2「零 embedding 成本」与 NFR-3「逐位确定」只在 ilike/chunked-ilike 时代严格成立；自本 spec 起每 run 花 30+ 次 query embedding（几美分，可接受），且 embedding API 不保证逐位确定、近分候选可能抖动排名。两条 NFR 的适用范围应注明为「harness 自身」——**同步 repo 时一并回标 SPEC-04**，免未来重验 AC-3 时对必然的假失败排障。

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | **接口契约不变**：工具名、出参结构、包裹格式与 SPEC-02 一致；filters 为纯新增可选参数；任何 MCP 客户端零配置改动可继续使用（SPEC-02 延期项承诺的兑现即本条） |
| INV-2 | SPEC-02 INV-3 包裹纪律逐 chunk 继续（转义先于包裹、双位置声明）——hybrid 不改变"检索内容是数据不是指令"的任何语义；家规一（[11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md) §3）在检索侧的执行面 |
| INV-3 | **filter MUST 下推**：过滤条件与相似度计算同查，never 先搜后筛（post-filtering 打穿结果集的教训，理论底稿方案一之弊的落地防线） |
| INV-4 | 未知 filter 键显式报错（FR-4 理由升格：过滤语义 never 静默降级） |
| INV-5 | 只读纪律继承：本服务器对 thoughts/chunks 仍仅 SELECT（+ add_thought 的 INSERT），never 破坏性工具（SPEC-02 INV-5 永续） |
| INV-6 | **eval 闭环**：本 spec 的关闭 MUST 以 golden set 对比数字为依据（AC-1），never 以"手感变好"关闭——评估基建行使裁决权的第一案 |
| INV-7 | 降级 never 静默：keyword-only 降级必须在返回体可见 + 日志可查（安静失败是整套设计的头号敌人，降级不标注就是自造安静失败） |

## 5. 接口契约

**search_thoughts 入参**（MCP tools/call）：
```json
{ "query": "string", "filters": { "sources": ["siri"], "created_after": "2026-06-01" } }
```
filters 整体可选、各键可选；schema 在 tools/list 中完整声明（含"未知键报错"说明）。

**hybrid_search RPC**：签名见 FR-2；返回列含 chunk_id / thought_id / chunk_index / content / source / created_at / fused_score / vector_rank / keyword_rank / thought_rank。

**RRF 公式落档**：`fused_score(c) = Σ_leg 1/(60 + rank_leg(c))`，仅在腿内出现的候选按该腿名次计分，另一腿贡献 0。

**降级返回样例**：正常结构前加一行 `[degraded: keyword-only — vector leg unavailable]`（包裹外，可信元数据区）。

**环境变量**：HYBRID_CANDIDATE_K（默认 50，候选池旋钮：越大越不易漏、延迟与未来 rerank 成本线性涨——理论底稿 §4 的旋钮原文）。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | **弧线闭环**：golden set 全量重跑，实现标识 "hybrid-rrf"，与 baseline 存档对比。**前置（G-5）：run 期间任一次检索降级（`[degraded:` 标注）→ 整个 run 作废，不得作关账依据；harness MUST 解析降级标注（升级列入派活单任务项）——否则一组静默 keyword-only 数字会被盖成 hybrid-rrf，仪器自成 INV-7 的静默失败源。排期（⑩）：避开写入窗口（每日 09:00/09:15 UTC 双 backfill cron、周日 15:00 UTC digest），排期前先查 cron 清单；凡按「日」聚合的账目先声明时区（凤凰城本地 17:00 起即入次日 UTC 账）。** | **B 层（语义改写）recall@10 严格高于基线——硬门槛，整条弧线的存在理由**；总体 recall@10 ≥ 基线；A 层（关键词）劣化 ≤ 5 个百分点；MRR 一并落档。**recall@10 与 MRR 均按不同 thought 的顺序计（thought 级真值锚，SPEC-04 INV-2）——同一 thought 的第二个 chunk never 重复计数（Codex FR-2 复核第7点）。** 数字回写本 spec 状态行与 SPEC-04 |
| AC-2 | 中文分桶单独看（golden set lang=zh 条目） | 观察点非门槛：若中文 recall 显著弱于英文 → 触发开放问题 2 的 pg_trgm 换腿实验。**判读口径（低危台账）：n=8 时一条 = 12.5 个百分点，判「显著弱于」看逐条明细而非只看比率。** |
| AC-3 | filter 正确性：造 source 不同、内容含同一关键词的两条 → filter `sources:["siri"]`；再测时间窗与组合过滤；最后发一个未知键 `{"foo":1}` | 只回 siri 条目；时间窗排除正确；组合 AND 正确；未知键 → -32602 参数错误 |
| AC-4 | **向后兼容**：不带 filters 的 tools/call（与 SPEC-02 时代同形请求）；Claude Code 客户端零配置改动实测 | 原样工作，返回结构一致 |
| AC-5 | **降级路径**：临时使 EMBEDDING key 失效 → 检索 | 200 + keyword 结果 + degraded 标注；恢复 key 后标注消失 |
| AC-6 | **注入回归**：SPEC-02 AC-7 / AC-7b 场景在 hybrid 路径重测（指令样式文本 + 伪造闭合标签各一条，让 Claude 搜到） | 包裹完整、转义生效、行为不被劫持——新返回路径上 INV-2 的实战复验 |
| AC-7 | 延迟：连续 10 次典型查询 | P95 < 1.5 秒（含 query embedding） |
| AC-8 | 退役确认：代码 grep NFR-2 截断逻辑（TRUNCATED 标记生成处） | 已移除；chunk 尺寸由 CHUNK_MAX 保证 |
| AC-9 | 语义实测（用户视角冒烟）：MCP 里搜一个词面不重合的意译 query（golden set B 层任一条的口语版） | 命中目标内容——ilike 时代做不到的那件事，亲手摸到 |
| AC-10 | rerankHook 代码审查 | 存在、恒等、位于 RRF 后截取前，签名与 FR-5 一致 |
| AC-11 | 仓库 grep 各 key 实际值 | 零匹配 |

## 7. 顺序与延期项

**顺序**：迁移（tsv + GIN）→ hybrid_search RPC（SQL 层先行单测：手工传入某已知 chunk 的向量验证两腿与融合）→ MCP 内部切换 + filters + 降级路径（AC-3/4/5）→ 注入回归（AC-6）→ **golden set 对比（AC-1/2，关闭裁决）** → 退役收账（AC-8）→ 收尾（AC-10/11）。

**回滚路径（低危台账）**：读路径切换 = edge function 重部署；AC-1 不达标 → 重部署上一版函数即回滚（成本近零）→ 排查，不在生产上现想。

**延期项**：
| 项 | 触发条件 |
|----|----------|
| rerank 实现（cross-encoder 或 rerank API） | eval 呈现"recall 高而 MRR 低"形态（货在 top-10 里但排不到前面）——正是漏斗第二段的存在理由，届时插 rerankHook 零重构 |
| keyword 腿换 pg_trgm | AC-2 观察到中文 recall 显著弱于英文 |
| sensitivity filter 字段 | 脑暴槽4 触发条件：首个非 thoughts 语料接入 |
| HyDE / 查询扩写 | B 层 recall 经调参到顶后仍不达预期 |
| 可观测聚合（FR-7 日志 → 面板/周报） | 真实检索量可观后；与"观测→golden set 飞轮"同批 |
| HYBRID_CANDIDATE_K 精调 | eval 数字驱动，不做超出必要的精调（SPEC-02 开放问题 1 同款克制） |

## 8. 开放问题

- [x] RRF vs 加权求和 —— **已决策：RRF**。两腿分数分布不可比（cosine 距离 vs ts_rank，量纲、范围、形状全不同），加权求和需先归一化再调权重——那是 eval 基建更成熟后的优化项，不是起点。RRF 无标度、免调参、只消费名次，对分布漂移稳健。加权求和留作 eval 驱动的后续实验。
- [x] tsvector 语言配置 —— **已决策：'simple'**。语料双语：'english' 配置对中文完全错配（无分词）；'simple' 对英文失去词干归并但保留精确 token 匹配。**中文侦察实测修正（2026-07-20，40% 语料为中文）：'simple' 并非「整句一个 token」，而是按标点/空格切分 → 得子句级长短语 token（如 'mc1r是一种基因变种'、'合成维他命d'）——既非中文词、又太长，短关键词难以匹配，故中文 keyword 腿实测偏弱，语义召回由 vector 腿承担（embedding 对 CJK 强）。此实测反而强化 pg_trgm 换腿理据：字符三元组会把这些长短语 token 打碎成可匹配单元。** **真正的裁决权交给 eval（AC-2）**——若中文 keyword 侧确有缺口，pg_trgm（字符三元组，对 CJK 天然友好）是换腿候选。这是评估基建第一次行使技术选型裁决权，也是它存在意义的现身说法。
- [ ] HYBRID_CANDIDATE_K=50 是否合适：候选池大小是"别漏"与延迟/未来 rerank 成本的旋钮。50 在当前量级近乎全库，实际是超额保险；量级上来后由 eval + AC-7 延迟共同校准。

---

[SPEC-06 Embedding 管线](SPEC-06-embedding-pipeline.md) · [SPEC-04 评估基建 — Golden Set 与检索指标](SPEC-04-eval-golden-set.md) · [SPEC-02 MCP 服务器](SPEC-02-mcp-server.md) · Retrieve vs Rerank — 双塔与单塔 · 检索时权限控制 — 落地方案 · [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md)
