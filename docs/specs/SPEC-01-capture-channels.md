# SPEC — Discord + Siri 捕获通道 v1.0

> 状态：✅ **Done（2026-07-06）**——AC-1至10 全部通过。quick-capture + discord-bot（commit 8a89ed7）均已部署实测；iOS 快捷指令（Save to brain）经控制中心/锁屏入口触发，落库 source='siri' 验证通过。注：CAPTURE_TOKEN 排查中曾外泄于聊天窗口，待轮换（§8 轮换触发信号已命中）
> 配套实施笔记：04a_Level-3 平替 - Discord + Siri（spec 定边界和验收，实施笔记管步骤和坑）
> 关键词等级：MUST = 违反即失败；SHOULD = 强烈建议，豁免需写明理由；MAY = 可选

---

## 1. 目标与非目标

**目标**：在 Open Brain 上增加两条移动捕获通道——Discord slash command（双向交互）与 iOS Shortcut（单向语音速记）——使"想法产生 → 落入 thoughts 表"的摩擦降到三秒级，且不引入任何未认证的公开端点。

**非目标**（v1 明确不做，新增前必须先修订本节）：
- 邮件入口（无转发文章的使用习惯）
- 共享 ingest 抽象层（两个入口各自直接 insert；触发抽象的条件是出现第三个入口）
- Telegram 通道（被本方案整体替代）
- 多用户支持、群聊监听、普通消息解析（仅 slash command）
- Discord 端富格式回复（embed、按钮）——纯文本足够

---

## 2. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | `/save <text>` 将 text 写入 thoughts 表，回复确认 |
| FR-2 | MUST | `/search <query>` 对 thoughts.content 做不区分大小写的子串匹配，返回最多 5 条（含时间戳） |
| FR-3 | MUST | `/recent` 返回最近 5 条想法 |
| FR-4 | MUST | quick-capture 端点接受 POST {content}，写入 thoughts 表，source 列记 'siri' |
| FR-5 | MUST | 来源标识用独立 source 列（枚举：siri / discord / mcp / web / digest），never 写进 content 前缀——content 保持纯净，不污染 content_hash 去重（SPEC-03 INV-6）、搜索匹配与 enrichment 输入；source 作为可信元数据在 MCP 返回时展示于包裹外（SPEC-02 INV-3 结构模板）。source 列在本 spec 实施时单独出一个编号迁移（一行 ALTER，先于 SPEC-03 的大迁移；编号迁移制下多一个小文件是常态非成本）。迁移形态：`ADD COLUMN source text NOT NULL DEFAULT 'web'`——存量行与 Level-1 web 端老代码零改动自动打标，且列上不出现 NULL |
| FR-6 | SHOULD | /search 无结果时返回明确的"没有找到"而非空响应 |
| FR-7 | MAY | /save 成功时回显被保存内容的前 50 字符 |

## 3. 非功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| NFR-1 | MUST | 所有 Discord interaction 在 3 秒内返回首个响应。v1 全部命令走即时响应（type 4）；任何未来新增的、会调用 LLM 的命令 MUST 走 deferred（type 5 + followup） |
| NFR-2 | MUST | 两个函数均为无状态 edge function，不引入常驻进程 |
| NFR-3 | SHOULD | quick-capture 端到端（Siri 说完 → 落库）在 5 秒内 |
| NFR-4 | MUST | 不产生新的月度固定成本（仅用 Supabase / Discord 免费层） |
| NFR-5 | MUST | Discord 回复中每条结果的 content 截断到 500 字符，截断 MUST 附可见标记，含剩余长度与 thought id（如 `…[还有 1,500 字符，完整内容见 thought id=xxx]`）；单条回复总长 MUST < 2000 字符（Discord 平台硬上限，超限 API 直接拒绝响应）。与 SPEC-02 NFR-2 同一哲学：never 静默截断 |

## 4. 不变量（任何代码路径、任何时刻必须成立）

| ID | 不变量 |
|----|--------|
| INV-1 | **验签先于解析**：discord-bot 必须先以原始请求体（raw body）完成 Ed25519 验证，之后才允许 JSON.parse。顺序颠倒视为安全缺陷，即使功能正常 |
| INV-2 | 验签失败 / token 不匹配的请求：返回 401，**不执行任何数据库操作，不在响应中泄露失败原因细节** |
| INV-3 | 机密（DISCORD_BOT_TOKEN、DISCORD_PUBLIC_KEY、CAPTURE_TOKEN）只存在于 Supabase Secrets；仓库内 grep 任何机密值结果必须为空 |
| INV-4 | 两个函数对 thoughts 表只做 INSERT 和 SELECT。不实现 UPDATE / DELETE——破坏性操作不属于捕获通道 |
| INV-5 | CAPTURE_TOKEN 为 ≥ 32 字节随机串；可轮换（改 Secrets + 改 Shortcut 两处即完成，不涉及代码改动） |
| INV-6 | 任何指向 thoughts 表的新公开端点 MUST 自带认证机制后才允许部署（继承自 [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) #2 的原则） |

## 5. 接口契约

**discord-bot**（POST，Discord Interactions 格式）
- 入：Discord interaction payload；头 X-Signature-Ed25519、X-Signature-Timestamp
- 出：type 1（PING 应答）/ type 4（即时内容）；HTTP 401（验签失败）
- 部署参数：--no-verify-jwt

**quick-capture**（POST）
- 入：头 Authorization: Bearer {CAPTURE_TOKEN}；体 { "content": string }
- 出：200 { "ok": true } / 401（token 错）/ 400 { "ok": false }（content 缺失或空串）
- 部署参数：**--no-verify-jwt（同样必须）**——Supabase 平台层默认把 Authorization: Bearer 头当项目 JWT 验，CAPTURE_TOKEN 是随机串非 JWT，不关掉请求到不了函数就被平台 401。函数内自己验 Bearer（INV-2）即是替代这层的认证（2026-07-04 实施前发现补入）

## 6. 验收标准（全部通过才算 Done）

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | 私人 server 内执行 /save 测试句 | Discord 收到确认；Table Editor 出现新行，source 列 = 'discord'，content 无任何前缀 |
| AC-2 | /search 用 AC-1 保存内容的关键词 | 返回结果包含该行 |
| AC-3 | /search 一个确定不存在的随机串 | 返回"没有找到"类信息，非空响应、非报错 |
| AC-4 | **负路径**：用错误的 Public Key 配置（或手工构造坏签名）发请求 | 收到 401；数据库无新行 |
| AC-5 | **负路径**：quick-capture 不带 Authorization 头、带错误 token 各发一次 | 两次均 401；数据库无新行 |
| AC-6 | "嘿 Siri，存想法" 说一句话 | 5 秒内 Table Editor 出现新行，source 列 = 'siri'，content 无任何前缀 |
| AC-7 | 在仓库根目录 grep token/key 的实际值 | 零匹配 |
| AC-8 | quick-capture 发 { } 空体 | 400，数据库无新行 |
| AC-9 | Discord 端点保存时的 PING 握手 | Endpoint URL 保存成功（这本身验证了 type 1 应答正确） |
| AC-10 | 存一条 > 500 字符的想法，/search 命中它 | 回复成功返回（非报错）；该条内容带截断标记，含剩余字符数与 thought id |

## 7. 顺序与延期项

**实施顺序**：
1. quick-capture（更简单，先打通"函数 → 表"路径）→ AC-5、AC-6、AC-8
2. discord-bot 验签骨架 + PING → AC-9、AC-4
3. 三条命令 → AC-1、AC-2、AC-3
4. 收尾 → AC-7，代码进 GitHub

**延期项（触发条件制）**：
| 项 | 触发条件 |
|----|----------|
| /search 切换 deferred 响应 | search 路径接入 pgvector 或任何 LLM 调用时（NFR-1 已预埋规则） |
| 共享 ingest 函数 | 出现第三个捕获入口时 |
| /digest 命令（按需触发周报） | Level 5 的 weekly-digest 函数上线后 |
| 速率限制 | 任一端点出现非本人流量迹象时 |

## 8. 开放问题

- [x] ~~thoughts 表来源标识用 content 前缀还是独立 source 列~~ **已决策（2026-07-03）**：独立 source 列，不等修复表 #5。新论据：(1) 前缀毒化 content_hash 去重（SPEC-03 INV-6）——同内容不同入口 hash 不同，去重失效白烧 LLM；还污染搜索匹配和 enrichment 输入。(2) SPEC-02 INV-3 结构模板已预设 source 为包裹外的独立可信元数据。(3) "等 #5 免改两次 schema"已失效：SPEC-03 本有一次迁移，source 列搭车边际成本一行；反而先用前缀将来要写清洗脚本剥前缀回填，才是真正的两次成本
- [x] ~~CAPTURE_TOKEN 轮换周期~~ **已决策（2026-07-03）**：仅泄露时轮换，维持原判。理由：定期轮换的价值是缩短"已泄露未察觉"凭据的存活窗口，前提是凭据分发广、泄露难察觉；本 token 暴露面仅 iPhone + Supabase Secrets，无第三人持有、不进日志（INV-2）、不进仓库（AC-7）。定期轮换对单人系统期望损失（改错一处 → Siri 静默失灵丢捕获）大于期望收益。**轮换触发信号（具体化）**：手机丢失/送修、快捷指令曾导出分享给他人、或 Supabase 日志出现非本人来源的 401/200。有信号才轮换，无信号不动

---

04a_Level-3 平替 - Discord + Siri · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) · 00_总览 - Build Your Own AI Brain
