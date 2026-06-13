# 仓库结构与 CLAUDE.md

> 用法：fork 教授的 open-brain-student → clone 到本地 cyber-exoskeleton 文件夹 → 按下面结构建目录 → 把本文件第二节的 CLAUDE.md 全文复制进仓库根目录 → 把 Specs/ 三份复制进 docs/specs/ → commit push。

---

## 一、仓库目录结构

```
cyber-exoskeleton/                ← fork 的 clone（仓库名仍是 open-brain-student 也无妨）
├── CLAUDE.md                     ← agent 的路由器，每次会话自动读取（见第二节）
├── docs/
│   ├── specs/                    ← 权威执行文档，agent 干活的依据
│   │   ├── SPEC-01-capture-channels.md
│   │   ├── SPEC-02-mcp-server.md
│   │   └── SPEC-03-agents-llm-gateway.md
│   └── curriculum/               ← 教授原版 Level-0 到 Level-5（英文原文，只读参考）
│       ├── Level-0-Setup.md
│       ├── Level-1-Build.md
│       ├── Level-2-Feed.md
│       ├── Level-3-Telegram.md   ← 保留原版，虽然实做被 SPEC-01 替代
│       ├── Level-4-MCP.md
│       └── Level-5-Agents.md
├── supabase/
│   ├── functions/                ← 所有 edge function（每个一个子文件夹 + index.ts）
│   └── migrations/               ← 编号迁移：001_init.sql 起步（FTHB 惯例）
├── index.html                    ← 课程自带的前端文件
├── config.js
└── migration.sql                 ← 课程原始建表脚本（执行后内容并入 migrations/001）
```

三个设计决定：
1. **spec 进仓库、中文译文留 vault。** 仓库版 spec 是 agent 读的权威版（git 版本化，改动有 diff 历史）；vault 里的 Specs/ 降级为思考底稿。译文（01–06 号文件）是给你自己看的，不进仓库。
2. **curriculum 保留原版英文**——它是"这个项目从哪来"的出处记录，也是 spec 出现分歧时的对照原文。CLAUDE.md 里会声明：冲突时 spec 胜过 curriculum。
3. **文件名转英文短横线**——spec 文件在命令行和 prompt 里会被高频引用，纯 ASCII 文件名省掉所有转义麻烦。vault 里保持中文名不变。

---

## 二、CLAUDE.md 全文（复制进仓库根目录）

```markdown
# Open Brain (Cyber Exoskeleton)

个人 AI 知识库：Supabase（数据库 + edge functions）+ Vercel（前端）+
MCP server（接 Claude Desktop）+ 自动化 agents。Fork 自
King-Tuerto/open-brain-student，按 docs/specs/ 下的规格逐步改造。

## 前置依赖（所有 spec 的地基）

SPEC-01、02、03 全部依赖 Level 0–2 的产出。地基未完成前不执行任何 spec 任务。

**必须存在的产出物：**
- Level 0：Git / Node 已装，GitHub / Supabase / Vercel 账户已就绪
- Level 1：Supabase 项目已建，`thoughts` 表已存在，`config.js` 已填入项目 URL 与 anon key，Vercel 部署已上线且页面可访问
- Level 2：前端升级完成（条目显示来源标签 + 顶部 Connected 状态圆点）

**规则：**
- 每次会话开始先读 `docs/STATUS.md`，确认当前起点再接受任何任务。
- 如收到 SPEC 任务但前置项未完成，停下来列出缺少的具体产出物，不执行。

## 工作规则（每次任务都适用）

1. **Spec 驱动。** 动任何代码之前，先完整阅读本次任务对应的 spec
   （路由见下表）。没有对应 spec 的改动，先停下来向我确认。
2. **INV 不可协商。** 各 spec 第 4 节的不变量在任何实现路径下必须成立。
   如果某个实现方案会违反 INV，不要变通绕过——停下来报告冲突。
3. **完成的定义 = AC 通过。** 任务指定的验收标准全部可演示通过才算完成。
   只测成功路径不算完成——AC 里的负路径（401、坏输入、空输入）同样必须验证。
4. **一次只做派给你的那一步。** 不要顺手重构、不要超出本次任务范围扩展功能。
   发现范围外的问题：记录并报告，不要直接修。
5. **歧义必须上浮。** 遇到 spec 没覆盖的设计决策，明确提出问题让我选择，
   不要静默选一个默认值。
6. **机密纪律。** 任何 API key、token、密码 never 写入仓库内任何文件。
   机密只存在于 Supabase Secrets。每次提交前确认 grep 不到机密值。

## Spec 路由表

| 任务涉及 | 必读 spec |
|---------|----------|
| Discord bot、Siri/quick-capture、任何捕获入口 | docs/specs/SPEC-01-capture-channels.md |
| MCP server（open-brain-mcp 函数）、Claude Desktop 接入 | docs/specs/SPEC-02-mcp-server.md |
| call-llm、enrich-thought、weekly-digest、pg_cron、任何 LLM 调用 | docs/specs/SPEC-03-agents-llm-gateway.md |
| 前端（index.html）、数据库 schema | 暂无 spec——动之前先向我确认 |

跨多个区域的任务：读全部相关 spec。SPEC-03 的 INV-1（所有 LLM 调用
必须经 call-llm 网关）对全仓库生效，不限于 SPEC-03 范围的任务。

## 目录约定

- docs/specs/ — 权威执行文档（中文）。docs/curriculum/ — 课程原文，
  只读参考；与 spec 冲突时以 spec 为准。
- supabase/functions/{name}/index.ts — 每个 edge function 一个文件夹
- supabase/migrations/ — 编号迁移（001_、002_…），schema 改动必须走迁移文件，
  不直接在 SQL Editor 手改后不留痕

## 常用命令

- 部署函数：supabase functions deploy {name} --project-ref $PROJECT_REF
  （Discord bot 需加 --no-verify-jwt，原因见 SPEC-01）
- 查函数日志：supabase functions logs {name} --project-ref $PROJECT_REF
- 本地起前端：直接开 index.html 或 npx serve .

## 技术约束备忘

- Edge functions 是 Deno 运行时（不是 Node）：用 Deno.env.get、
  内置 fetch、npm 包需 npm: 前缀导入
- Discord interaction 有 3 秒应答窗口——任何调 LLM 的命令必须走
  deferred（type 5 + followup），规则在 SPEC-01 NFR-1
- Supabase webhook 调用方收到非 200 会重试——webhook 类函数永远返回 200，
  失败写日志和 status 列（SPEC-03 INV-7）
```

---

## 三、初始化顺序（一次性）

1. GitHub 上 Fork → 本地 `git clone <你的fork URL> cyber-exoskeleton`
2. `mkdir -p docs/specs docs/curriculum supabase/functions supabase/migrations`
3. 教授的 6 个原版 .md 放进 docs/curriculum/
4. vault 的 Specs/ 三份复制进 docs/specs/（按上面的英文文件名重命名）
5. 仓库根目录建 CLAUDE.md（第二节全文）
6. `git add . && git commit -m "Add CLAUDE.md, specs, curriculum docs" && git push`
7. 验证：在仓库目录开一个 Claude Code 会话，问它"这个项目的工作规则是什么"——它应该能复述 spec 路由表。能复述 = 第一层投喂机制生效

---

[[Specs/SPEC-01 Discord + Siri 捕获通道]] · [[07_升级路线 - Edge Cases 修复表]]
