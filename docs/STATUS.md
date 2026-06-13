# 项目状态 · Open Brain (Cyber Exoskeleton)

> 每次会话开始必读。完成一项后立刻更新此文件，保持状态与实际一致。

## 进度 Checklist

### 地基（Level 0–2）

- [x] **Level 0 — 工具与账户**
  产出物/验证：Git / Node 已装；GitHub、Supabase、Vercel 账户已就绪

- [ ] **Level 1 — Supabase 项目 + 数据库 + 前端部署**
  产出物/验证：Supabase 项目已建 → `thoughts` 表存在 → `config.js` 填入 SUPABASE_URL 与 ANON_KEY → Vercel 部署上线 → 访问 Vercel URL 看到绿色 Connected 圆点且能保存/读取条目

- [ ] **Level 2 — 升级版前端 + 来源标签**
  产出物/验证：访问 Vercel URL 可见 Voice / YouTube / PDF / URL / Search 五个标签页；语音说一句话能落库且带来源前缀；手机浏览器能"添加到主屏幕"安装

### Spec 实施（依赖地基全部完成）

- [ ] **SPEC-01 — Discord + Siri 捕获通道**
  产出物/验证：AC-1 到 AC-9 全部通过（见 docs/specs/SPEC-01-capture-channels.md §6）

- [ ] **SPEC-02 — MCP 服务器**
  产出物/验证：AC-1 到 AC-8 全部通过（见 docs/specs/SPEC-02-mcp-server.md §6）

- [ ] **SPEC-03 — 自动化代理与 LLM 网关**
  产出物/验证：AC-1 到 AC-11 全部通过（见 docs/specs/SPEC-03-agents-llm-gateway.md §6）

---

最近更新：2026-06-12
当前下一步：完成 Level 1 — 建 Supabase 项目，创建 thoughts 表，配置 config.js，部署到 Vercel
