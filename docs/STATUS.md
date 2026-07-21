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

> 说明：Level 1–2 保留课程原版前端验收口径，目前未在本仓库重新验收；
> 下列 Spec 状态按各自 AC 的后端实施证据记录。

- [x] **SPEC-00 — Done**
- [x] **SPEC-01 — Done**
- [x] **SPEC-02 — Done**
- [x] **SPEC-03 — Done**
- [x] **SPEC-04 — Done**（2026-07-16；真实基线仅本地保存，公开仓库提供 eval 格式示例）
- [x] **SPEC-08 — Done**
- [x] **SPEC-05 — Done**（2026-07-17；十条 AC 全绿）
- [x] **SPEC-06 — Done**（2026-07-19；十条 AC 全绿）
- [x] **SPEC-07 — Done**（2026-07-20；Hybrid recall@10 0.9487，B 层 1.0，P95 1244ms）

---

最近更新：2026-07-20
当前下一步：RAG 04→07 弧线已收官；按 Vault 后续派活推进。
