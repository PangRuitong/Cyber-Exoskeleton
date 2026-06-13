# SPEC — Discord + Siri 捕获通道 v1.0

> 状态：Draft → 实施时改 Active → 验收全过改 Done
> 配套实施笔记：[[04a_Level-3 平替 - Discord + Siri]]（spec 定边界和验收，实施笔记管步骤和坑）
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

| ID   | 等级   | 需求                                                                                             |
| ---- | ------ | ------------------------------------------------------------------------------------------------ |
| FR-1 | MUST   | `/save <text>` 将 text 写入 thoughts 表，回复确认                                                |
| FR-2 | MUST   | `/search <query>` 对 thoughts.content 做不区分大小写的子串匹配，返回最多 5 条（含时间戳）        |
| FR-3 | MUST   | `/recent` 返回最近 5 条想法                                                                      |
| FR-4 | MUST   | quick-capture 端点接受 POST {content}，写入 thoughts 表，来源前缀标记 🎤 Siri                    |
| FR-5 | MUST   | Discord 写入的行带来源标识（💬 Discord 前缀或 source 字段），与 Level 2 各通道的来源标注惯例一致 |
| FR-6 | SHOULD | /search 无结果时返回明确的"没有找到"而非空响应                                                   |
| FR-7 | MAY    | /save 成功时回显被保存内容的前 50 字符                                                           |

## 3. 非功能性需求

| ID    | 等级   | 需求                                                                                                                                                     |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-1 | MUST   | 所有 Discord interaction 在 3 秒内返回首个响应。v1 全部命令走即时响应（type 4）；任何未来新增的、会调用 LLM 的命令 MUST 走 deferred（type 5 + followup） |
| NFR-2 | MUST   | 两个函数均为无状态 edge function，不引入常驻进程                                                                                                         |
| NFR-3 | SHOULD | quick-capture 端到端（Siri 说完 → 落库）在 5 秒内                                                                                                        |
| NFR-4 | MUST   | 不产生新的月度固定成本（仅用 Supabase / Discord 免费层）                                                                                                 |

## 4. 不变量（任何代码路径、任何时刻必须成立）

| ID    | 不变量                                                                                                                                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| INV-1 | **验签先于解析**：discord-bot 必须先以原始请求体（raw body）完成 Ed25519 验证，之后才允许 JSON.parse。顺序颠倒视为安全缺陷，即使功能正常 |
| INV-2 | 验签失败 / token 不匹配的请求：返回 401，**不执行任何数据库操作，不在响应中泄露失败原因细节**                                            |
| INV-3 | 机密（DISCORD_BOT_TOKEN、DISCORD_PUBLIC_KEY、CAPTURE_TOKEN）只存在于 Supabase Secrets；仓库内 grep 任何机密值结果必须为空                |
| INV-4 | 两个函数对 thoughts 表只做 INSERT 和 SELECT。不实现 UPDATE / DELETE——破坏性操作不属于捕获通道                                            |
| INV-5 | CAPTURE_TOKEN 为 ≥ 32 字节随机串；可轮换（改 Secrets + 改 Shortcut 两处即完成，不涉及代码改动）                                          |
| INV-6 | 任何指向 thoughts 表的新公开端点 MUST 自带认证机制后才允许部署（继承自 [[07_升级路线 - Edge Cases 修复表]] #2 的原则）                   |

## 5. 接口契约

**discord-bot**（POST，Discord Interactions 格式）

- 入：Discord interaction payload；头 X-Signature-Ed25519、X-Signature-Timestamp
- 出：type 1（PING 应答）/ type 4（即时内容）；HTTP 401（验签失败）
- 部署参数：--no-verify-jwt

**quick-capture**（POST）

- 入：头 Authorization: Bearer {CAPTURE_TOKEN}；体 { "content": string }
- 出：200 { "ok": true } / 401（token 错）/ 400 { "ok": false }（content 缺失或空串）

## 6. 验收标准（全部通过才算 Done）

| ID   | 验证步骤                                                               | 必须观察到                                                   |
| ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| AC-1 | 私人 server 内执行 /save 测试句                                        | Discord 收到确认；Table Editor 出现新行，含 Discord 来源标识 |
| AC-2 | /search 用 AC-1 保存内容的关键词                                       | 返回结果包含该行                                             |
| AC-3 | /search 一个确定不存在的随机串                                         | 返回"没有找到"类信息，非空响应、非报错                       |
| AC-4 | **负路径**：用错误的 Public Key 配置（或手工构造坏签名）发请求         | 收到 401；数据库无新行                                       |
| AC-5 | **负路径**：quick-capture 不带 Authorization 头、带错误 token 各发一次 | 两次均 401；数据库无新行                                     |
| AC-6 | "嘿 Siri，存想法" 说一句话                                             | 5 秒内 Table Editor 出现带 🎤 前缀的新行                     |
| AC-7 | 在仓库根目录 grep token/key 的实际值                                   | 零匹配                                                       |
| AC-8 | quick-capture 发 { } 空体                                              | 400，数据库无新行                                            |
| AC-9 | Discord 端点保存时的 PING 握手                                         | Endpoint URL 保存成功（这本身验证了 type 1 应答正确）        |

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

- [ ] thoughts 表来源标识用 content 前缀（与课程 Level 2 一致）还是独立 source 列？倾向独立列（可过滤、可统计），但需与 Level 2 升级（修复表 #5 分表）一并决定，避免改两次 schema
- [ ] CAPTURE_TOKEN 轮换周期：定期轮换 vs 仅泄露时轮换？v1 先按"仅泄露时"，不增加日常负担

---

[[04a_Level-3 平替 - Discord + Siri]] · [[07_升级路线 - Edge Cases 修复表]] · [[00_总览 - Build Your Own AI Brain]]
