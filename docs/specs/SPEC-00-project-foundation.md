# SPEC-00 — 项目底座与访问控制（RLS 清账）v1.0

> 状态：**Done（2026-07-05，AC-1至7 全部通过）**；项目按 §2 创建于 2026-07-04；§5 同日修订 v1.1——补 default privileges 清账，见 §2 补充发现
> 关账路径备查：AC-1/2/6/7 于 07-04 实测；AC-3/4 于 07-05 由一次性验证脚本清账（.delete() 被拒 = INV-2 验证通过）；AC-5 于 07-05 由 SPEC-01 quick-capture 首次落库触发
> **决策（2026-07-04）**：Level-1 web 端降级为可选、无限期延后——本系统价值链是捕获入口 → DB → AI 读取（MCP）→ 自动化，web 端不在链上。AC-3/AC-4 改由一次性验证脚本清账（signInWithPassword 登录 → 读写一次 → .delete() 确认被拒），§7 顺序中的 "Level-1 web 端带登录" 相应替换为此脚本。FR-4 的原则（任何未来 web 客户端从第一行代码带登录）不变
> 前置于：[SPEC-01 Discord + Siri 捕获通道](SPEC-01-capture-channels.md)（本 spec 是修复表 #1 的落地载体，也是全部后续 spec 的地基）
> 吸收修复表条目：#1 —— **性质已变更**：项目按 fail-closed 三开关创建，#1 描述的"匿名读写洞"不会存在；本 spec 的任务从"修洞"变为"保证洞从一开始就不出现"
> 关键词等级：MUST / SHOULD / MAY

---

## 1. 目标与非目标

**目标**：Supabase 项目从第一天起满足——匿名（anon key）对 thoughts 表零读零写；唯一能经 Data API 访问数据的身份是本人（authenticated 角色，注册已关闭）；edge functions 经 service role 不受影响。

**非目标**（v1 不做）：
- 多用户 / `user_id` 列方案（触发条件：修复表 #5 分表时，或真实出现第二个用户；届时单用户回填 = 一句 UPDATE，不欠债）
- OAuth / 第三方登录（邮箱密码足够）
- web 端之外的任何登录（Siri / Discord / MCP 走各自 spec 的认证，与 Auth 无关）

## 2. 项目创建参数（已执行，留档）

| 开关 | 取值 | 理由 |
|------|------|------|
| Enable Data API | **开** | supabase-js / REST 的基础，Level-1 web 端依赖 |
| Automatically expose new tables | **关** | fail-closed：新表默认对 Data API 角色零权限，须手动 GRANT 才可见。"忘配权限 = 全不可见"而非"= 全网可读"。INV-6（SPEC-01）的数据库层同构 |
| Enable automatic RLS | **开** | 新表出生即带 RLS，须显式策略才放行 |

> **⚠ 补充发现（2026-07-04，实施中）**：以上开关**不足以**做到出生零权限。Supabase 在 `public` schema 上预设了 `ALTER DEFAULT PRIVILEGES`，新表会自动获得授予 anon / authenticated 的一组默认权限（含 REFERENCES / TRIGGER / TRUNCATE 等）。GRANT 是加法不是替换，§5 的 GRANT 语句不会清除这些默认授权。修复：§5 已加入一次性的 default privileges REVOKE，执行后新表才真正出生零权限（INV-3 从纪律变为机制保证）。TRUNCATE 尤其危险——它不受 RLS 管辖，且比 DELETE 更彻底，与 INV-2 直接冲突。

## 3. 功能性需求

| ID | 等级 | 需求 |
|----|------|------|
| FR-1 | MUST | Authentication 中手动创建唯一账户（本人邮箱 + 强密码） |
| FR-2 | MUST | 关闭公开注册（Sign In / Up → Allow new users to sign up = off）。此后 authenticated 角色 ≡ 本人，策略无需区分用户 |
| FR-3 | MUST | thoughts 表建表迁移中包含权限与策略（见 §5），never 事后补 |
| FR-4 | MUST | Level-1 web 端**从第一行代码起带登录**（`signInWithPassword`，约 30 行；session 由 supabase-js 持久化，登录一次长期有效）。课程原文的 anon key 直连写法在本项目不可用——实施时 MUST 偏离课程，agent 派活时随单说明 |

## 4. 不变量

| ID | 不变量 |
|----|--------|
| INV-1 | anon 角色对任何含用户数据的表 never 拥有任何权限或放行策略 |
| INV-2 | authenticated 角色 never 被授予 DELETE——捕获系统不提供破坏性操作（与 SPEC-01 INV-4、SPEC-02 INV-5 同一原则，权限层焊死） |
| INV-3 | 任何新表 MUST 显式经过"GRANT + 策略"两步才对 Data API 可见（依赖 §2 的开关组合，此处声明为纪律防止将来手滑打开 auto-expose） |
| INV-4 | 公开注册保持关闭；重新打开的唯一合法理由是转多用户方案（那属于另立 spec） |

## 5. 建表迁移必含片段

```sql
-- 0. 一次性断源头：撤掉 public schema 对 Data API 角色的默认授权
--    （Supabase 预设 default privileges 会给新表自动发权限，此句执行一次后
--     所有将来新表出生即零权限，INV-3 才真正成立；幂等，可重复执行）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- RLS 已由 automatic RLS 触发器启用，无旧策略可删（fail-closed 出生）
GRANT SELECT, INSERT, UPDATE ON thoughts TO authenticated;  -- 无 DELETE（INV-2）
GRANT ALL ON thoughts TO service_role;                       -- edge functions 走此角色，绕过 RLS

-- 清账：撤掉建表时 default privileges 已经发出去的多余权限
--（若表建于上面第 0 段执行之后则此段为空操作，留着保证幂等与自愈）
REVOKE ALL ON thoughts FROM anon;
REVOKE REFERENCES, TRIGGER, TRUNCATE ON thoughts FROM authenticated;

CREATE POLICY "owner_only" ON thoughts
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
```

注：`FOR ALL` 在策略层含 DELETE，但 authenticated 无 DELETE 的表级权限，GRANT 层已拦——策略是放行条件，权限是能力上限，两层取交集。

**权限验证查询**（每次建表 / 改权限后跑，anon 应零行，authenticated 应恰好 SELECT / INSERT / UPDATE 三行）：

```sql
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'thoughts'
  AND grantee IN ('anon', 'authenticated')
ORDER BY grantee, privilege_type;
```

## 6. 验收标准

| ID | 验证步骤 | 必须观察到 |
|----|----------|-----------|
| AC-1 | **负路径**：anon key 直接 curl `GET /rest/v1/thoughts`（表内须先有数据，防把"空表"误判成"被拒"） | 空数组或权限错误——匿名零可读 |
| AC-2 | **负路径**：anon key POST 一行 | 拒绝；Table Editor 无新行 |
| AC-3 | web 端登录后读写 | 正常 |
| AC-4 | **负路径**：登录态下尝试 DELETE 一行（supabase-js `.delete()`） | 被拒（INV-2 的验证） |
| AC-5 | 任一 edge function（quick-capture 起）写入 | 照常落库——service role 不受 RLS 与 GRANT 收紧影响 |
| AC-6 | Auth 设置截图/核对 | 公开注册关闭；用户列表仅一人 |
| AC-7 | 跑 §5 权限验证查询 | anon 零行；authenticated 恰好 SELECT / INSERT / UPDATE 三行（无 REFERENCES / TRIGGER / TRUNCATE） |

## 7. 顺序

项目创建（已完成）→ FR-1/2（Dashboard 手工，5 分钟）→ thoughts 建表迁移含 §5 片段 → AC-1/2/6 → Level-1 web 端带登录 → AC-3/4 → SPEC-01 动工（其间随 AC-5 验证）。

---

[SPEC-01 Discord + Siri 捕获通道](SPEC-01-capture-channels.md) · [07_升级路线 - Edge Cases 修复表](../engineering/edge-cases-and-fixes.md) · 09_实施前备忘 - 非阻塞事项
