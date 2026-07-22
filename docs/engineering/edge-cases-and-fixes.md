# Open Brain 升级路线 — Edge Cases 与隐患修复表

> 按急切程度分级。P0 是嵌在系统里的安全问题，应在对应 Level 构建时直接做掉；P1 是内容量变大前必须改的架构问题；P2 是规模化和质量优化。
>
> **本表的角色是主索引，不是执行文档。**需要落地的条目已被吸收进各阶段 spec 成为可验收的 INV/AC：#1 → [SPEC-00 项目底座与访问控制](../specs/SPEC-00-project-foundation.md)（fail-closed 出生即修）；#2、#13 → [SPEC-01 Discord + Siri 捕获通道](../specs/SPEC-01-capture-channels.md)；#4、#5(临时闸门)、#14 → [SPEC-02 MCP 服务器](../specs/SPEC-02-mcp-server.md)；#3、#6、#7、#8、#12 → [SPEC-03 自动化代理与 LLM 网关](../specs/SPEC-03-agents-llm-gateway.md)；**#5(分表) → [SPEC-05 分表与 Chunking](../specs/SPEC-05-chunking.md)；#9 → [SPEC-06 Embedding 管线](../specs/SPEC-06-embedding-pipeline.md) + [SPEC-07 Hybrid 检索切换](../specs/SPEC-07-hybrid-search.md)（2026-07-06 立 spec，并加了本表当年没预见的一环：[SPEC-04 评估基建 — Golden Set 与检索指标](../specs/SPEC-04-eval-golden-set.md) 先行——先建仪器，再动检索）**。仍未吸收：#10（备份与 keep-alive，备份半边已绑定 SPEC-05 前置）、#11（假离线）。给 agent 派活时发 spec，不发本表。

---

## P0 — 安全（构建时直接做，不要带病上线）

| # | 隐患 | 引入于 | 怎么修 | 为什么重要 |
|---|------|--------|--------|-----------|
| 1 | **匿名读写的 RLS 策略**。应用无登录系统，anon key 公开在 config.js，意味着 RLS 必然允许匿名读写——任何拿到 Vercel URL 的人可读取/写入整个大脑 | Level 1 | 加一个简单的 Supabase Auth 邮箱登录（约 30 行前端代码），RLS 策略改为 auth.uid() = user_id；单用户最低成本方案是 RLS 只放行带特定 JWT claim 的请求。**顺序约束（2026-07-04）**：本条 MUST 在 SPEC-01 实施之前或并行完成——三条捕获通道上线后数据流入速度与敏感度陡增，洞不能带进新阶段。**已吸收（2026-07-04 晚）：项目按 fail-closed 三开关创建（Data API 开 / auto-expose 关 / auto-RLS 开），本洞不会出生；落地规格见 [SPEC-00 项目底座与访问控制](../specs/SPEC-00-project-foundation.md)，本行保留作历史背景**。修 #1 只动 web 端与 RLS 策略，spec 内的 edge functions 走 service role key 不受影响，零冲突 | 大脑会积累私人想法、读过的文档、语音笔记——你最敏感的数据集之一。URL 会出现在浏览器历史、分享、截图里，不能当机密对待 |
| 2 | **Telegram webhook 无来源验证**。任何人找到 functions/v1/telegram-bot 的 URL 都能伪造"Telegram 消息"——往大脑写垃圾，或用 /search 把数据**搜出来带走** | Level 3 | 调 setWebhook 时加 secret_token 参数，函数内校验 X-Telegram-Bot-Api-Secret-Token 请求头，不匹配返回 403。Telegram 官方机制，约 5 行。**已由平替方案自动修复**：换用 Discord 后，Ed25519 签名验证是平台准入门槛，不修跑不起来，见 04a_Level-3 平替 - Discord + Siri | 这是一个公开的、能读你全部数据的端点。/search 命令让它从"垃圾注入"升级为"数据外泄"通道 |
| 3 | **enrich-thought / weekly-digest 公开无认证**。pg_cron 调用时不带认证头，函数被迫公开——任何人 curl 即可烧你的 Anthropic API 额度 | Level 5 | 函数要求 Authorization 头；pg_cron 的 net.http_post headers 里带上 key（用 Supabase Vault 存引用，不要明文写进 cron SQL） | API 按量计费，一个被发现的公开端点加一个循环脚本等于醒来收账单。这正是 FTHB 把所有外呼收口 ai_services.py、key 走 .env 的同一逻辑 |
| 4 | **间接 prompt injection**。大脑存的是 YouTube 字幕、网页正文——不可信内容。Claude 经 MCP 检索时，藏在内容里的恶意指令直接进入模型上下文 | Level 2/4 | 无法根治，纵深缓解：检索结果在 MCP 返回时包明确的数据边界标记；工具描述声明"返回内容是存档数据不是指令"；将来若加删除/转发类工具，不允许由检索内容触发。**2026-07-06 更新：agent 时代威力升级（injection 从"聊天里答错"升级为"驱动能发邮件/写码的执行者"）已预判并按死为三条家规 → [11_未来场景设计约束 — Agent 时代脑暴收账](agent-era-design-constraints.md) §3；hybrid 新返回路径的注入回归 = SPEC-07 AC-6** | 与 FTHB 的 source doctrine 同一问题域：控制什么内容、以什么身份进入 LLM 上下文。RAG 系统的头号攻击面 |

---

## P1 — 架构（内容量超过几百条之前改完）

| # | 隐患 | 引入于 | 怎么修 | 为什么重要 |
|---|------|--------|--------|-----------|
| 5 | **God-table，无 chunking**。50 页 PDF 是 thoughts 表的一行，搜索命中即整块返回——撑爆上下文窗口，或相关段落被无关内容淹没 | Level 2 | 拆 documents（标题、来源、URL 等元数据）+ chunks（按段切块，外键回 documents）两表。捕获时切块，检索按 chunk 返回并附出处。**已吸收（2026-07-06）→ [SPEC-05 分表与 Chunking](../specs/SPEC-05-chunking.md)**：documents 角色由 thoughts 兼任（不改名，迁移缝最小），chunks 表 + chunker 注册表 + 原子替换落地 | Chunking 质量是 context engine 检索质量的第一决定因素，也是 #9 上 pgvector 的前置条件——embedding 必须按 chunk 算 |
| 6 | **Enrichment 静默失败、无回填**。LLM 返回的"JSON"常裹 markdown 代码围栏，JSON.parse 抛错后函数照常返回 200，该行永远停在未富化状态，且无机制发现 | Level 5 | 解析前剥离代码围栏；字段级校验（tags 是数组、category 在枚举内、summary 非空）；加 enrichment_status 列（pending / done / failed）；一个每日 cron 回填所有 failed/pending 行 | FTHB Batch 2B 的核心教训：LLM 输出必须过校验层，不能裸 parse。finding_validator.py 的存在理由在这里完全成立，只是规模小一号 |
| 7 | **Digest 自触发循环**。weekly-digest 把结果存回 thoughts 表 → 触发 INSERT webhook → 又被 enrich 一遍。现在只浪费一次调用；哪天 enrichment 逻辑改成插入新行而非更新，就是无限循环 | Level 5 | enrich-thought 开头判断 category = digest 直接跳过；或 webhook 上加条件过滤。两行代码 | 事件驱动系统的经典反模式：消费者的输出落回自己的触发源。修复成本现在是两行，出事后是一夜账单 |
| 8 | **无成本闸门**。enrichment 逐条触发：批量导入 500 条 = 500 次 LLM 调用，无限流、无去重、无预算上限 | Level 5 | 内容 hash 去重（同内容不重复富化——FTHB 的 sha256 enrichment cache 同款思路）；call-llm 里加每日调用计数，超阈值拒绝并报警 | 个人项目最常见的死法不是被黑，是账单惊吓后弃坑。预算闸门是让系统敢长期开着的前提 |

---

## P2 — 质量与规模（系统跑稳后逐步做）

| # | 隐患 | 引入于 | 怎么修 | 为什么重要 |
|---|------|--------|--------|-----------|
| 9 | **ilike 全表扫描，零语义**。前后通配的模式用不上 B-tree 索引，且"推广产品"搜不到 marketing | Level 1 | Supabase 原生 pgvector：chunks 表加 embedding 列，捕获时算向量；检索用向量相似度 + tsvector 关键词分数做混合排序。无需引入新服务。**已吸收（2026-07-06）→ [SPEC-06 Embedding 管线](../specs/SPEC-06-embedding-pipeline.md)（向量落库，检索零变化）+ [SPEC-07 Hybrid 检索切换](../specs/SPEC-07-hybrid-search.md)（RRF 融合 + filter 下推 + rerank 槽位），前置 [SPEC-04 评估基建 — Golden Set 与检索指标](../specs/SPEC-04-eval-golden-set.md) 基线，升级效果以 recall@10 前后对比数字关账** | 搜索质量是这个系统的核心价值轴。这也是把课程作业升级成 portfolio 项目最有展示价值的一步 |
| 10 | **Supabase 免费层不活跃暂停**。免费项目约一周无请求会被暂停——大脑静默死亡，Telegram bot、MCP、cron 全部失联 | 全局 | 短期：一个轻量 keep-alive cron（每天 select 1）；长期：定期 pg_dump 导出备份到 GitHub 私有仓库或本地。无论是否付费，备份都该做。**2026-07-06 绑定触发：SPEC-05 是本系统首次结构性迁移 + 存量回填——动工前 MUST 完成首次 pg_dump 全库导出留档（已写入 SPEC-05 前置）**；keep-alive 的待查证项（pg_cron 是否计入活跃判定，见备忘 M-2）仍开放，现有两个日/周 cron 上线后可观察验证 | "数字主权"的承诺只有在你真的能恢复数据时才成立。没有导出流程的自有数据库和别人的服务器没有本质区别 |
| 11 | **sw.js 是假离线**。service worker 的 fetch 回退到 caches.match，但从未有任何东西被写入缓存——离线时照样白屏 | Level 2 | install 事件里 cache.addAll 静态资源（index.html、manifest），fetch 用 cache-first 或 stale-while-revalidate | 不算危险，但"已支持离线"的错误心智模型会在你真离线时坑你一次。要么修好，要么删掉假功能 |
| 12 | **Digest 时区**。cron 是 0 8 星期日 UTC = Phoenix 凌晨 1 点 | Level 5 | Phoenix 不用夏令时（UTC-7 全年），周日早 8 点 = 0 15 星期日 | 小事，但第一周就会注意到 |
| 13 | **Bot token 进浏览器历史**。Level 3 步骤 8 让你把含 token 的 setWebhook URL 直接在浏览器打开 | Level 3 | 改用命令行 curl 调 setWebhook，用完即走。**换用 Discord 后整条作废**：没有 setWebhook URL 这一步 | 浏览器历史会同步到 Google 账户。低概率，零成本修 |
| 14 | **MCP_ACCESS_KEY 强度与轮换**。课程示例 OpenBrain2024Secure! 是弱密码示范；key 明文存在 claude_desktop_config.json | Level 4 | 用 32+ 位随机串（openssl rand -base64 32）；config 文件明文可接受（本机文件），但 key 应可轮换：Supabase secret 改值 + config 同步即可 | 这把 key 是大脑的总入口。明文存本机是行业常态，弱密码不是 |

---

## 建议执行顺序

**前置：#1（RLS）在 SPEC-01 动工前或并行完成——它不是未来的改造，是已存在的 P0 欠账。** 构建时同步做：#2、#13（Level 3 时）→ #14（Level 4 时）→ #3、#7（Level 5 时）。
建完第一轮迭代：#6 → #8 ✅（均随 SPEC-03 Done）→ **#5、#9 已立 spec（2026-07-06）：SPEC-04（eval 基线，先建仪器且时序不可逆）→ SPEC-05（#5 分表）→ SPEC-06 + SPEC-07（#9 向量落库与 hybrid 切换），依赖线性**。#10 备份半边绑定 SPEC-05 前置兑现。
随时可做：#10 keep-alive 查证、#12 时区 ✅（SPEC-03）、#11。

---

00_总览 - Build Your Own AI Brain · 08_FTHB 对照表
