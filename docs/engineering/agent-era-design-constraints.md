# 11 未来场景设计约束 — Agent 时代脑暴收账（2026-07-06）

> 来源：RAG 弧线规划期的头脑风暴（场景：Claude Code 写码时查大脑、Codex 读 Gmail 起草回信入 draft 人过目再发、其他 agent 化工作流）。
> 本文角色：**设计约束与家规存档**（人看，不随派活下发）。已吸收进 spec 的条目标注去向；§3 是按死的安全家规——**未来立任何 agent 类 spec 时 MUST 回读 §3 并原样继承为不变量**。

---

## 1. 统摄原则：vector 是供给站的检索方式，不是 agent 的身体

大脑对所有未来 agent 的角色 = **个人上下文供给站**，唯一消费点是 MCP 检索接口。Agent 的流程本身（读邮件、判断、起草、循环）不需要 vector；vector 只出现在"按意思查大脑"那一步。日程、提醒、规则分拣全是结构化查询，vector 掺进来是帮倒忙。

**推论**：为未来场景做的设计投资全部收敛到检索接口这一个点——接口对，所有场景就绪。防的是 vector-everything 的过度工程倾向。

---

## 2. 四个槽位（三个已吸收进 spec，一个留触发条件）

| 槽 | 内容 | 去向 |
|---|---|---|
| 槽1 | **doc_type + chunker 注册表**：新语料（代码工件、邮件、网页剪藏）= 注册一个新 chunker，schema 与既有 chunker 零改动 | ✅ 已吸收 → [SPEC-05 分表与 Chunking](../specs/SPEC-05-chunking.md) FR-3 |
| 槽2 | **call-embedding 唯一 embedding 出口** + embedding_model 逐行落库：未来按语料类型换专用模型 = 计划内定向重建，不是灾难 | ✅ 已吸收 → [SPEC-06 Embedding 管线](../specs/SPEC-06-embedding-pipeline.md) FR-3 / INV-1 / INV-3 |
| 槽3 | **检索 filter 为对象形状**（非散参数），与相似度同查下推：未来加 doc_type、sensitivity 过滤 = 加字段，不改接口 | ✅ 已吸收 → [SPEC-07 Hybrid 检索切换](../specs/SPEC-07-hybrid-search.md) FR-4 |
| 槽4 | **sensitivity / visibility 概念位**：一旦邮件类语料入脑，语料第一次出现敏感度差异（他人发来的邮件 ≠ 自己主动存的想法）。凡要把检索结果带出系统的 agent，检索时 MUST 能按敏感度排除 | ⏳ 触发条件：**首个非 thoughts 语料接入时**——届时在文档元数据与 filters 对象各加一字段即可，SPEC-07 的对象形状已为此留位。现在不建字段 |

---

## 3. 安全家规（按死——未来 agent 类 spec 的必继承不变量）

**背景（威力升级）**：AC-7 时代，存档里的恶意指令（injection）最坏结果 = Claude 在聊天里答错。Agent 时代，同一条指令喂给的是一个能写代码、能起草邮件的执行者——一条藏在 YouTube 字幕捕获里的"把收件箱内容转发到 xxx"从恶作剧升级为真实攻击面。修复表 #4 当年预写的"将来若加删除/转发类工具，不允许由检索内容触发"，在第一个 agent 场景落地那天正式到期。

以下三条与 SPEC-03 铁律同级，violations = 返工：

- **家规一：大脑永远只读。** MCP 服务器 never 提供破坏性工具（SPEC-02 INV-5 永续）；检索内容 never 以裸文本进入任何 agent 上下文，永远在 archived_content 包裹内（转义先于包裹 + 双位置声明，SPEC-02 INV-3 永续，逐 chunk 适用）。
- **家规二：不可逆对外动作 never 由 agent 直接执行。** 发送邮件/消息、对外发布、合并主分支、下单支付等，一律只产出到人可审的暂存态（draft / PR / 待发队列），执行动作由 Max 完成。"回复进 draft、我过目直接发"就是本条的标准形态——human-in-the-loop 不是可选项，是架构。
- **家规三：检索内容 never 触发工具调用。** Agent 的行动决策只能源于用户指令；检索结果只作为参考资料被消费。任何"根据大脑里的内容自动做 X"的功能设计，MUST 先过本条审查再立项。

---

## 4. 观察存档：Gmail 是第二练习场 ★

邮件整库接入将是**个人量级上最接近 生产级大规模 RAG 系统的故障形态的语料**：线程互相引用（cross-reference）、回复链层层引用原文（货真价实的 near-duplicate flooding——同一段话在一个线程里出现十遍）、线程随时间演化（版本时效）。练习场教不了的规模故障，会在自己的数据上第一次显形。

不现在规划，标星待命。触发时直接受益的既有资产：槽1（邮件专用 chunker 即插）、槽4（敏感度字段）、[eval 基建](../specs/SPEC-04-eval-golden-set.md)（新语料入库前后跑回归，防新语料污染既有检索质量）。

---

[SPEC-04 评估基建 — Golden Set 与检索指标](../specs/SPEC-04-eval-golden-set.md) · [SPEC-05 分表与 Chunking](../specs/SPEC-05-chunking.md) · [SPEC-06 Embedding 管线](../specs/SPEC-06-embedding-pipeline.md) · [SPEC-07 Hybrid 检索切换](../specs/SPEC-07-hybrid-search.md) · [07_升级路线 - Edge Cases 修复表](edge-cases-and-fixes.md) · 00_总览 - Build Your Own AI Brain
