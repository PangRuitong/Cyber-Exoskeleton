# SPEC-05 — 分表与 Chunking v1.0

> 状态：✅ Done（2026-07-17，十条 AC 全绿）。RAG 弧线第二步。
> **前置一：SPEC-04 基线已落档（SPEC-04 INV-4，派活单开工前检查项）。**
> **前置二：pg_dump 全库导出留档（修复表 #10 备份半边的首次兑现）——本 spec 是系统首次结构性迁移 + 存量回填，动工前 MUST 有可恢复快照（导出存 GitHub 私有仓或本地，验证能打开能读）。Max 手动项。**
> 吸收修复表条目：#5（god-table 分表 + chunking）。
> 理论底稿：Chunking 策略 — 断裂与解耦——small-to-big 解耦（"索引单元 ≠ 上下文单元"）与异构路由在本 spec 定型。
> 吸收脑暴槽位：槽1（chunker 注册表），见 [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md) §2。
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：chunks 表落地 + 确定性切块管线（webhook + backfill 双模式，SPEC-03 同款形态）+ 检索读端切到 chunk 级返回（**仍是 ilike**）。small-to-big 的返回结构（命中 chunk、附带 parent 元数据）在本 spec 定型。

**非目标**（v1 不做）：
- embedding（SPEC-06 的事——本 spec 零模型调用，验收不依赖任何 API key）
- 语义切块 / proposition / contextual augmentation（触发条件：结构切块在 eval 上撞墙、交叉引用类失败成为主要失败模式）
- thoughts 改名 documents（决策见开放问题 1）
- 跨文档引用图 / 二跳检索
- 新语料类型实际接入（doc_type 插槽本 spec 留好，v1 语料仍只来自四个既有入口）

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | 建表 `chunks`：`id uuid PK DEFAULT gen_random_uuid()`、`thought_id uuid NOT NULL REFERENCES thoughts(id)`、`chunk_index int NOT NULL`、`content text NOT NULL`、`content_hash text GENERATED ALWAYS AS (encode(sha256(content::bytea),'hex')) STORED`、`chunker text NOT NULL`、`created_at timestamptz NOT NULL DEFAULT now()`、`updated_at timestamptz NOT NULL DEFAULT now()` + BEFORE UPDATE 触发器、`UNIQUE(thought_id, chunk_index)`。新表出生零权限（default privileges 已断源，SPEC-00 状态），service_role 可写即可 |
| FR-2 | MUST | thoughts 加列：`chunking_status text NOT NULL DEFAULT 'pending'`（枚举 pending / done / failed）、`chunked_at timestamptz`。存量行自动 pending，进入回填视野（SPEC-03 同款"隐身行不存在"原则） |
| FR-3 | MUST | **chunker 注册表**（脑暴槽1）：一个纯函数路由 `route(doc) → chunker`，v1 注册两个：**passthrough**（content 长度 ≤ CHUNK_THRESHOLD → 整行即一个 chunk，chunk_index=0）与 **structure**（recursive 切分：先 `\n\n`、再 `\n`、再句子边界；目标 CHUNK_TARGET、硬上限 CHUNK_MAX、被迫切开完整段落时相邻块 CHUNK_OVERLAP 重叠）。**加一种新语料 = 注册一个新 chunker + 一条路由规则，schema 与既有 chunker 零改动** |
| FR-4 | MUST | 新 edge function `chunk-thought` 双模式（同 enrich-thought 形态）：**webhook 模式**（thoughts INSERT 触发，与 enrich-thought 并挂同一 webhook 事件；对调用方 always 200，失败进 status）+ **backfill 模式**（验 Authorization + `{mode:"backfill"}`，扫 `chunking_status IN ('failed','pending')`，逐行处理）。**digest 行不豁免**——切块零 LLM 零成本，且 digest 内容可检索有价值（与 enrichment 的豁免逻辑不同源：那边防的是自吞循环烧钱，这边不存在该风险） |
| FR-5 | MUST | **原子替换**：写 chunks 走单个 RPC（postgres 函数 `replace_chunks(p_thought_id uuid, p_chunks jsonb)`，SECURITY 按 service_role 调用设计）：同一事务内 DELETE 该 thought 旧 chunks → INSERT 新集 → UPDATE thoughts 的 chunking_status='done' + chunked_at。理由：检索在线读 chunks，非原子替换会留下"文档暂时搜不到"的窗口 |
| FR-6 | MUST | MCP `search_thoughts` 读端切换：ilike 匹配对象从 thoughts.content 改为 chunks.content；返回条目 = chunk 正文（包裹内）+ parent 元数据（thought id / created_at / source，包裹外）+ 位置标注（"chunk 2/7 of thought id=…"）；**同一 thought 最多 2 个 chunk 进结果**（近重复挤占的迷你防线——理论底稿 near-duplicate flooding 的本地版）；总条数上限仍 10 |
| FR-7 | MUST | 存量回填：全部既有 thoughts 经 backfill 完成切块 |
| FR-8 | SHOULD | `list_recent` 行为不变（继续读 thoughts——它是"最近捕获了什么"的文档级语义，不是检索） |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 切块纯确定性：零 LLM、零外呼、零新增成本（同输入永远同输出——INV-3 幂等的基础） |
| NFR-2 | MUST | 单文档切块（30 页级粘贴）< 5 秒 |
| NFR-3 | MUST | 检索响应仍 < 5 秒（SPEC-02 NFR-1 继承） |
| NFR-4 | MUST | SPEC-02 NFR-2 的 2000 字符截断在新返回路径上**保留为保险丝**（chunker 硬上限 CHUNK_MAX 使其正常永不触发）；正式拆除在 SPEC-07 收账，本 spec 不动该代码——一个 spec 只动一类东西 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | **content 是事实源**：切块 never 改写、截断、注入 thoughts.content（M-6 同款原则——原文永不因派生过程被动） |
| INV-2 | **chunks 是派生数据**，可随时全量重建；DELETE 仅允许出现在 replace_chunks 的原子替换事务内；thoughts 表 never DELETE（SPEC-03 纪律不变） |
| INV-3 | **幂等**：同一 thought 重切结果逐字节一致（确定性 chunker + 原子替换共同保证）；重复触发无副作用累积 |
| INV-4 | chunker 选择 MUST 落库（chunks.chunker 列）——未来多 chunker 共存时可按 chunker 定向重建，也是切块策略变更的审计痕迹 |
| INV-5 | 认证纪律全套继承：webhook 触发器从 Vault 读 key 随请求携带（SPEC-03 落地模式，不豁免），backfill 验 Bearer，端点不裸奔 |
| INV-6 | 检索返回的 chunk 正文继续走 SPEC-02 INV-3 包裹（转义先于包裹、双位置声明），**逐 chunk 应用**；可信元数据在包裹外 |
| INV-7 | 状态机无死路：chunk-thought 任何失败路径显式落 failed，never 无状态退出（切块无外呼、无需 retrying 态——状态机比 enrichment 少一档是刻意的，不要为对称而对称） |

## 5. 接口契约

**chunk-thought**（POST，双模式）
- webhook：Supabase webhook payload（record 含新 thought 行）；always 200；副作用 = replace_chunks + status
- backfill：Authorization 头 + `{ mode: "backfill" }`；出 200 `{ processed, succeeded, failed }`

**replace_chunks RPC**：`replace_chunks(p_thought_id uuid, p_chunks jsonb) → void`，p_chunks = `[{ chunk_index, content, chunker }]`，单事务。

**search_thoughts 返回样例**（结构与 SPEC-02 一致，内容单位变为 chunk）：
```
Result 3 of 9 (thought id=182, chunk 2/7, created 2026-05-12, source: siri):
<archived_content>
...chunk 正文...
</archived_content>
```

**环境变量**（全部有默认值，函数内读取）：
| 变量 | 默认 | 说明 |
|---|---|---|
| CHUNK_THRESHOLD | 1200 | ≤ 此长度走 passthrough（覆盖几乎全部 Siri/Discord 捕获） |
| CHUNK_TARGET | 800 | structure chunker 目标块长 |
| CHUNK_MAX | 1200 | 硬上限，任何 chunk never 超过 |
| CHUNK_OVERLAP | 150 | 被迫切开完整段落时的相邻重叠 |

迁移文件入 supabase/migrations 沿用现有编号序列。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 插入一条短想法（< CHUNK_THRESHOLD） | 30 秒内恰 1 条 chunk，chunker='passthrough'，chunk_index=0，chunking_status='done' |
| AC-2 | 插入一条长文本（> 5000 字符，含多段落） | 多条 chunk；无块超 CHUNK_MAX；chunk_index 从 0 连续；status='done' |
| AC-3 | **幂等**：对同一 thought 手动触发切块两次 | 两次后 chunk 集合（content_hash 序列）逐字节一致，无重复行、无孤儿行 |
| AC-4 | 审 replace_chunks 定义 | DELETE+INSERT+UPDATE 在单一函数/事务内（原子性以事务语义代验） |
| AC-5 | 存量回填后查询 | 无 chunking_status='pending' 的存量行；抽查长/短各一确认切块正确 |
| AC-6 | MCP search 一个只在某长文档中部出现的关键词 | 返回的是相关 chunk 而非整文（god-table 症状消失的直接观察）；同 thought ≤ 2 chunk |
| AC-7 | **负路径**：backfill 无认证头 | 401，零数据库操作 |
| AC-8 | **golden set 回归**：重跑 SPEC-04 harness，实现标识 "chunked-ilike" | 总体 recall@10 相对基线劣化 ≤ 5 个百分点（本 spec 是结构改造非检索升级，允许小幅波动，不许大幅回退）。**这是 eval 基建第一次履行回归职责** |
| AC-9 | 以 anon key 尝试读写 chunks 表 | 拒绝（零权限验证，SPEC-00 惯例） |
| AC-10 | 仓库 grep 各 key 实际值 | 零匹配 |

## 7. 顺序与延期项

**顺序**：前置检查（SPEC-04 基线在档 + pg_dump 快照留档，两项缺一不开工）→ 迁移（chunks 表 + chunking_status + replace_chunks RPC）→ chunker 注册表与两个 chunker（纯函数，本地单测切分行为）→ chunk-thought webhook 模式（AC-1/2）→ backfill 模式 + 存量回填（AC-5/7）→ MCP 读端切换（AC-6）→ golden set 回归（AC-8）→ 收尾（AC-9/10）。

**延期项**：
| 项 | 触发条件 |
|----|----------|
| contextual augmentation（块前贴定位说明） | eval 中交叉引用/上下文缺失类失败成为主要失败模式 |
| 表格线性化专用 chunker | 首个含大量表格的语料接入 |
| thoughts 补文档级元数据列（title / url） | 首个网页/文档类语料接入 |
| chunk 归档/分区 | chunks 行数 > 100k |

## 8. 开放问题

- [x] thoughts 是否改名 documents —— **已决策：不改名**。thoughts 本就是 source-of-truth，改名波及 quick-capture / enrich-thought / weekly-digest / MCP / webhook 触发器全链路，纯命名收益配不上迁移风险。修复表 #5 的实质（元数据与切块分离、检索按 chunk 返回并附出处）全部达成，"documents"角色由 thoughts 兼任。
- [x] enrichment 是否搬到 chunk 级 —— **已决策：不搬**。tags/category/summary 是文档级语义，chunk 级富化 = 成本 ×N 且无消费者。**勘误**：09 备忘 M-3 中"#5 完成后与 NFR-2 同批退役"的说法不再成立——enrichment 保持文档级，其 4000 字符输入截断继续有效，长期保留直至 enrichment 策略本身变更。NFR-2 按本 spec NFR-4 的安排在 SPEC-07 退役。
- [x] CHUNK_THRESHOLD=1200 的校准 —— **已关闭（07-16 决策门，数据裁决）**：侦察实测 1201–2000 区间零行，担忧情形不存在；维持 1200。回填后实测：4198 字符长文切 6 块 max 781，AC-8 零劣化，无需调参。

## 9. 验收记录（2026-07-17，十条 AC 全绿）

- AC-1 ✅ 新捕获端到端（富化 + 切块双触发器并挂实证，Max 实测）；AC-2 ✅（4198 字符 → 6 chunks，max 781 < 1200）；AC-3 ✅（同 thought 两次 POST，(chunk_index, content_hash) 序列逐字节一致，6→6 不翻倍）；AC-4 ✅（replace_chunks 单事务）；AC-5 ✅（存量 25 行全 done，共 33 chunks）；AC-6 ✅（资本主义长文中部词经 MCP 命中，带 chunk i/n，同 thought 限 2）；AC-7 ✅（双触发器同 INSERT 开火）；AC-8 ✅（chunked-ilike recall@10 = 33.33% vs 基线 33.33%，零劣化，存档 eval/runs/2026-07-17-spec05-chunked.json 及 -ac6.json）；AC-9 ✅（anon 读 chunks → 401）；AC-10 ✅（全仓密钥实际值零命中）。

**验收期间事件与教训**（详情见 HANDOFF 2026-07-16 — SPEC-05 派活单）：
1. **UTF-8 探针陷阱**：AC-6 首次"失败"实为 PowerShell 探针未显式 UTF-8，中文 query 乱码。测量仪器坏了不是系统坏了——已归档 Control/13。
2. **三处密钥同步**：AGENT_ACCESS_KEY 轮换期间 Vault / Function Secrets / .env 短暂不一致 → 触发器 401 窗口 → 双管线 pending 积压。WARNING 降级 + backfill 双保险按设计兼住（捕获零损失），链路修复后积压自愈——降级决策的首次实战验证。已归档 Control/13。
3. 实施中 Codex 两次正确拒停：门禁数据陈旧（STATUS.md 漂移）宁停不猜；spec 不在 repo 拒绝臆定 schema。流程修补：**spec 收官同步更新 repo 侧 docs/STATUS.md + spec 落 repo** 已加入收官清单。

---

[SPEC-04 评估基建 — Golden Set 与检索指标](SPEC-04-eval-golden-set.md) · [SPEC-06 Embedding 管线](SPEC-06-embedding-pipeline.md) · Chunking 策略 — 断裂与解耦 · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) · [11_未来场景设计约束 — Agent 时代脑暴收账](../engineering/agent-era-design-constraints.md)
