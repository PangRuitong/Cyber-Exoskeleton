# SPEC-08 — Discord 错误回执与捕获幂等 v1.2

> 状态：✅ Done（2026-07-14，全部 AC 手动验证通过）。v1.1（2026-07-08）：吸收实施前审计。v1.2（同日）：吸收侦察单 A 发现——content_hash 实为 GENERATED ALWAYS 列（旧算法无规范化无日期，0/21 行匹配目标算法，迁移改换列流程）；discord-bot 直插 thoughts 不经 quick-capture，hash 计算下沉为数据库 BEFORE INSERT 触发器（比函数单点更强的不变量）；effort 契约、哨兵行处置已裁决。**独立小任务（半天级），与 RAG 弧线（04→07）完全正交，不进依赖链，可随时插队。**
> **⚠ 勘误（2026-07-19 追记，事故后）**：本 spec 的哈希触发器函数 `compute_thought_content_hash` 建时**漏 GRANT**——SPEC-00 硬化后默认授权源已拆，service_role 无执行权，导致 MCP add_thought 与 digest 的直插路径自 07-08 起静默失败十一天（捕获路径走 SECURITY DEFINER RPC 无感，掩盖了缺口；当时未回归 MCP 写路径）。于 SPEC-06 AC-1 暴露，修复见迁移 20260719235835（最小授权 service_role）。事故档案与教训（N-4 写路径回归、N-5 硬化后授权义务）见 12_RAG 弧线实施前审计 — 存档 SPEC-06 段。
> 吸收修复表条目：无（自立项）。顺路补齐一个借本任务暴露的老缝：插入级幂等（见 FR-7 与 INV-3——本 spec 一半的价值在这条）。
> 范围声明：**本 spec 报的是捕获路径的错**（quick-capture 同步返回）。捕获 200 之后的下游异步失败（enrichment，及 RAG 弧线后的 chunking / embedding）在 Discord 回执时刻尚未发生，归宿是各自的 status 列 + backfill；对它们的**主动通知**是另一个任务，见延期项 1（大概率会做，设计预告已写好）。
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：Discord 捕获回执携带真实结果——成功直发状态码；失败**先发原始错误保底，再追补一条 5.4-mini 翻译的人话解释**；同时把 thoughts 插入改造为幂等（重试无害化）。

**非目标**（v1 不做）：
- 下游管线（enrichment / chunking / embedding）失败的主动通知（延期项 1）
- Siri 通道的错误回执改造（延期项 2——Shortcut 的回执机制完全不同，别混）
- 错误的自动修复/重试编排（报告器只报告）
- Discord 之外的通知渠道

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | **成功路径零 LLM**：quick-capture 返回 2xx → 直接回执 `✅ saved (200)`，不经任何模型调用 |
| FR-2 | MUST | **Deferred response 改造**：interaction 收到后 3 秒内先应答 type 5（deferred），后续结果经 interaction token（15 分钟有效）以 PATCH 追补。这是本 spec 唯一的结构性改动。**执行模型**：ack MUST 在任何实际工作（含 DB 插入）之前立即返回；ack 之后的全部工作（插入 → PATCH → 翻译追补）MUST 包在 `EdgeRuntime.waitUntil()` 内——Edge Function 在 HTTP 响应返回后即终止，不包 = ack 后代码根本不执行；反向（先干活再 ack）= 撞 3 秒硬约束。**部署顺序硬约束：FR-7 幂等 MUST 先于或同批于本条上线**——deferred 把「插入成功但回执未达」的 kill 窗口从毫秒级撑大到秒级，用户等不及重发的概率显著上升；先上 deferred 后上幂等 = 窗口已扩大、护栏未安装的裸奔期 |
| FR-3 | MUST | **失败路径两段式**：失败发生 → **立即 PATCH 原始错误**（HTTP 状态码 + 错误摘要，截断至安全长度）→ 随后异步追补一条翻译消息（follow-up）。顺序 never 颠倒：原始码是保底，翻译是锦上添花。waitUntil 内两段 never 串行阻塞：PATCH 原始码不 await 翻译或任何其他调用，翻译为独立 follow-up POST。内部写入（discord-bot 直插 thoughts，v1.2 确认现状架构）超时/断连 = 插入成败未知态，MUST 按失败报告，never 猜测成功——用户重发由 FR-7 无害化。PATCH `@original` 为编辑同一条消息，天然幂等，可安全重试一次 |
| FR-4 | MUST | call-llm 加可选入参 `effort?: "none" \| "low" \| "medium" \| "high"`，**不传时行为与现状完全一致**（向后兼容，AC-6 验证）。翻译调用传 EFFORT_ERROR_TRANSLATE（环境变量，默认 low） |
| FR-5 | MUST | 翻译调用 MUST 经 call-llm 网关（SPEC-03 INV-1 无豁免）。prompt：输入 = 状态码 + 规范化错误结构（never 含用户捕获正文，见 INV-4），输出 = 一两句中文人话 + 一句"用户现在该做什么"（重试 / 等待 / 找 Max 看日志） |
| FR-6 | MUST | **错误风暴去重**：错误文本规范化后取 hash，新表 `error_translations(error_hash text PK, translation text, created_at timestamptz)`——1 小时窗口内同 hash 复用已有翻译（直接发缓存），不重复调 LLM。DB 抽风连挂 20 条捕获 = 1 次翻译调用 + 19 次缓存复用。窗口过期后同 hash 再现：`ON CONFLICT (error_hash) DO UPDATE` 刷新 translation 与 created_at，never 撞 PK 炸出。**hash MUST 算在 INV-4 剥离步骤之后的文本上**——若先 hash 后剥离，攻击者持 capture token 发送畸形载荷即可用无限不同的错误回显值击穿去重缓存，每条一次 LLM 调用直至撞预算闸门；INV-4 不只是隐私纪律，是本条去重的安全基石 |
| FR-7 | MUST | **插入级幂等（日期桶作用域，数据库触发器实现——v1.2 改）**：`content_hash = sha256(normalize(content) + '\|' + UTC日期YYYY-MM-DD)`。normalize = trim + 换行符统一为 `\n`，**到此为止**。hash MUST 由 thoughts 表 **BEFORE INSERT 触发器**计算（v1.2 决策依据：侦察发现 discord-bot 直插 thoughts 不经 quick-capture，「函数单点」假设不成立；触发器 = 任何写入路径物理上无法绕过，入口会分叉、数据库不会；不用生成列是因日期格式化非 IMMUTABLE，生成列表达式不收）。**现有列为 GENERATED ALWAYS（encode(sha256(content::bytea),'hex')，无规范化无日期，0/21 行匹配目标算法），生成列不可 UPDATE，迁移 = 换列**：① Max 手动删哨兵行 ×2（已裁决：唯一碰撞组为 07-07 AC6 测试哨兵，两行均删，id 记入 AC-7 存档）；② drop 生成列（旧非唯一索引 thoughts_content_hash_idx 随之消失）；③ 建普通 text 列；④ 全量按目标算法重算填充（按各行 created_at 的 UTC 日期）；⑤ 建 BEFORE INSERT 触发器；⑥ 建唯一索引。**连带影响排查（MUST）**：enrich-thought 现有代码按 content_hash 查重——换算法后其查询语义改变（旧 hash 纯内容、新 hash 掺日期），迁移时 MUST 审计全仓库对 content_hash 的引用并逐处确认新语义下仍正确或修改。插入方（quick-capture 与 discord-bot 直插处**各自**）改 `ON CONFLICT (content_hash)` 并返回已有行（实现注意：`DO NOTHING` 时 `RETURNING` 对冲突行返空——需 `DO UPDATE SET content_hash = EXCLUDED.content_hash RETURNING id` 或冲突后补 SELECT，MUST 拿到已有行 id），响应/回执标注 dedup。never 让迁移静默失败或静默删数据；脚本 MUST 幂等，重跑无害 |
| FR-8 | SHOULD | 翻译追补失败（call-llm 429/502/超时）→ 静默放弃，函数日志记一行，用户端零感知（手里已有原始码） |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 首应答（deferred ack）< 3 秒（Discord 平台硬约束） |
| NFR-2 | SHOULD | 翻译追补 < 30 秒到达 |
| NFR-3 | MUST | 翻译调用计入 LLM_DAILY_BUDGET 同闸门无豁免；但 never 指望闸门防风暴——FR-6 去重是第一防线，闸门是最后防线（闸门触发本身也是一个要解释的错误） |
| NFR-4 | MUST | 成本忽略级：effort=low 的单次错误翻译在千分之一美分量级，加上 FR-6 去重，本功能不构成可感知成本 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | **错误报告路径 never 依赖 LLM 可用性**。错误发生的时刻恰是系统不健康的时刻，"错误解释器"自己也可能挂——原始码先行保底，翻译只做追补。反向设计（等翻译、翻译失败才发原始码）= 给报错系统装单点，属返工级违规 |
| INV-2 | 翻译 MUST 经 call-llm（SPEC-03 INV-1 继承）；discord-bot never 直连任何提供商 API |
| INV-3 | **插入幂等（日期桶作用域）**：同（规范化内容 × UTC 日期）never 产生第二行；**跨日重复视为新思想**（已决策 2026-07-08：kill 窗口是分钟级，解法作用域 MUST 匹配问题作用域——永久全局去重 = 数月后重捕获同一想法被静默吞噬，属最坏故障类「静默数据丢失」，比崩溃更坏因为崩溃会喊）。已知代价：跨 UTC 午夜的重发会产生重复行——概率极低、可见、可清理，远比静默吞噬便宜。normalize 规则一经上线 never 更改（改 = 换 hash 函数，全部历史行失去去重保护）。并发正确性 MUST 依赖唯一索引 + ON CONFLICT 的数据库原子性，never 用应用层先查后插替代（check-then-insert 存在竞态缝隙，两个并发实例可双双漏过）。受益者是**全部写入路径**——hash 由数据库触发器计算（v1.2），任何入口（含未来 agent 直插）never 能绕过，不只 Discord |
| INV-4 | 翻译 prompt never 携带用户捕获正文——翻译对象是系统响应不是内容；错误体若可能内嵌内容片段（如 DB 约束错误回显值），规范化步骤 MUST 剥离 values 只留错误类型与约束名（大脑内容不进不必要的 LLM 调用，与 SPEC-06 INV-6 日志纪律同源） |
| INV-5 | 本功能全部副作用为只读性质（发消息、调翻译、写翻译缓存）——重复执行最坏结果是重复消息，never 改变任何数据状态。因此报告功能自身无需幂等设计，幂等设计只针对其顺路暴露的插入问题（FR-7） |

## 5. 接口契约

**call-llm 新入参**（增量，全部可选）：
```json
{ "prompt": "...", "effort": "low" }
```
不传 effort = 现状行为。出参不变。

**Discord 回执样例**：
- 成功：`✅ saved (200)`
- 去重：`✅ already saved (dedup, 200)`
- 失败（第一段，立即）：`❌ capture failed — HTTP 500: insert into thoughts failed (23502 not_null_violation)`
- 失败（第二段，追补）：`💬 数据库拒绝了这次写入：某个必填字段是空的。这通常是捕获内容为空导致——重发一次带内容的消息即可；若重发仍失败，需要 Max 看函数日志。`

**环境变量**：EFFORT_ERROR_TRANSLATE（默认 low）、ERROR_DEDUP_WINDOW（默认 3600 秒）。

**重复执行语义备忘**（设计依据，写死存档）：Discord slash interaction 为一次性投递，平台 never 自动重试——重复的真实来源是**人**，窗口 = "DB 插入成功之后、回执送达之前"函数被杀（重启/超时/部署），用户看到失败而手动重发。FR-7 幂等键即为此而设。

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 正常捕获一条 | 回执含 ✅ 与 200；call-llm 零调用（日志确认） |
| AC-2 | 人为制造失败（如临时改坏 quick-capture 的表名） | 3 秒内 deferred ack → 原始错误消息 → 30 秒内翻译追补，顺序正确 |
| AC-3 | **保底验证**：使 call-llm 不可用（临时坏 key）+ 制造捕获失败 | 用户仍收到原始错误码；无翻译；discord-bot 无 5xx；日志有一行静默放弃记录 |
| AC-4 | 连发 5 条触发同一错误 | error_translations 仅 1 行；LLM 仅 1 次调用；5 条回执均含翻译（后 4 条为缓存复用） |
| AC-5 | **幂等验证（kill 窗口模拟）**：同一内容连发两次 | thoughts 仅 1 行；第二次回执标注 dedup；四入口任一通道重发同内容均不产生新行 |
| AC-6 | **向后兼容**：不带 effort 调 call-llm（enrich-thought / weekly-digest 现有调用样式） | 行为与改造前一致（出参结构、模型参数不变） |
| AC-7 | 存量查重步骤留档 | 迁移前的重复行检查结果与裁决记录（若零重复也记"零重复"） |
| AC-8 | 仓库 grep 各 key 实际值 | 零匹配 |

## 6a. 验收记录（2026-07-14，Max 手动 Discord 验证）

- AC-1 ✅（前期已验，✅ saved (200)，零 LLM 调用）
- AC-2 ✅：坏表名（discord-bot 直插处，非 quick-capture——v1.0 AC 措辞已过时）→ 原始错误先到，翻译追补到达。处理快于展示 thinking 状态，NFR-1 满足
- AC-3 ✅：坏 key 下仅收原始错误码，无翻译，保底路径成立（INV-1）
- AC-4 ✅：连发 5 条同错误，error_translations 仅 1 行，LLM 仅 1 次调用，5 条回执均含翻译
- AC-5 ✅：同内容连发两次，thoughts 仅 1 行，第二次回执标注 dedup；措辞体感可接受
- AC-6 ✅（Codex 实施报告阶段已验，不带 effort 行为与现状一致）
- AC-7 ✅（哨兵行 ×2 已删，id 已存档）
- AC-8 ✅（仓库 grep 零匹配）

**验收期间的一处追加改动**：翻译 prompt 从"字面翻译"升级为"人话 + 因果类别猜测 + 行动建议"（对齐 FR-5 回执样例的原意），约束：只推断类别不编造细节，INV-4 输入剥离不变。重测注意项：改 prompt 后需先清 error_translations 缓存，否则 1 小时窗口内拿到旧翻译。

## 7. 顺序与延期项

**顺序（v1.2）**：0）[已闭合 2026-07-08] effort 契约——现状：env `LLM_REASONING_EFFORT` 仅 OpenAI 分支写 `reasoning_effort`，请求体无此字段；落法：**入参 effort > LLM_REASONING_EFFORT > 不发送**，Anthropic 分支忽略并注释说明。另：线上 secret 值未确认，B 单含 secrets 名称清单（不取值）核对 → 1）Max 手动删哨兵行 ×2（迁移前置，id 记 AC-7）→ 2）换列迁移（FR-7 ②–⑥）+ error_translations 表，脚本幂等 → 3）quick-capture 与 discord-bot 插入处各自 ON CONFLICT + dedup 分支（AC-5）→ 4）call-llm effort 入参（AC-6）→ 5）discord-bot deferred + waitUntil（AC-2；**MUST 晚于步骤 3**，FR-2 硬约束）→ 6）两段式错误路径 + 去重（AC-3/4）→ 7）验收 + `.env` 正名（连接串入 DATABASE_URL，SUPABASE_URL 改回 https 项目地址）→ 收尾。

**延期项**：
| 项 | 触发条件与设计预告 |
|----|----------|
| **下游管线失败主动通知器**（大概率要做） | 触发：RAG 弧线上线后，chunking_status / embedding_status / enrichment_status 三条状态机在线运行时。**设计预告**：数据源 = 各 status 列的 failed 行；形态 = **日检 cron 汇总推送**（与 backfill 同节奏，一天一条摘要），never 逐条实时推——异步管线的失败本来就由 backfill 自愈，逐条推送 = 把自愈系统变成告警噪音源；直接复用本 spec 的翻译（call-llm + effort）与去重（error_translations）两个部件，届时立 spec 时只需写数据源与推送格式 |
| Siri 通道错误回执 | 触发：Siri 捕获失败造成实际困扰被观察到（Shortcut 回执机制不同，独立评估） |
| 捕获路径统一（discord-bot 改道 quick-capture） | 触发：无硬触发，属架构清理项。v1.2 已用触发器把幂等下沉到数据库，入口分叉不再危及正确性；统一的价值只剩减少重复代码，优先级低 |
| 错误翻译多语言 | 触发：无（中文人话即目标态） |

## 8. 开放问题

- [x] effort 默认值 —— **已决策：low**。none 对诡异堆栈解释力不足，medium 对"翻译一个 HTTP 错误"是纯延迟；low 是折中，且 EFFORT_ERROR_TRANSLATE 可随时改，不用站队。
- [x] 去重窗口 —— **已决策：1 小时**。风暴场景（连续失败）都在分钟级；窗口过长会让"同错误码、不同根因"的翻译陈旧。
- [x] dedup 回执措辞 —— **已关闭（2026-07-14）**：AC-5 实测，Max 体感可接受，不改。
- [x] 回执可见性（ephemeral flag）—— **已决策（2026-07-08）：公开**。单人服务器无隐私需求，公开消息可回看可搜索（ephemeral 消息刷新后不可追溯，不利于事后查错）。type 5 应答不带 ephemeral flag。

---

[SPEC-01 Discord + Siri 捕获通道](SPEC-01-capture-channels.md) · [SPEC-03 自动化代理与 LLM 网关](SPEC-03-agents-llm-gateway.md) · 00_总览 - Build Your Own AI Brain
