# 15_检索运营教义 — RAG 是活系统

> 立档：2026-07-21。性质：**教义（doctrine），长期**——与 [13_设计压力测试清单](design-pressure-test.md) 并列的第二本教义，但 13 管**设计评审**（写码前的压力测试），本文件管**运营 / 生命周期**（交付后的长期维护）。触发：SPEC-07 收账时的一句认识——检索不是一锤子买卖。
> 一句话：**hybrid 检索交付 ≠ 完工。它是活系统，要持续验证、调参、终将加 rerank；eval golden set 是量它的仪器，仪器本身也得随语料长大。**
> 现在语料小（30 thoughts / 40 chunks），下面的杠杆全休眠；立此档是为了**语料 10× / 100× 后不靠记忆、靠触发条件唤醒**。

---

## 核心原则

1. **检索质量随语料漂移，不随代码冻结。** 同一套 hybrid 代码，30 条时 recall 0.95，3000 条时可能塌——候选竞争变大、chunk 语义密度变化、长文占比上升（G-2 单位效应复发）。**代码没变 ≠ 质量没变。**
2. **golden set 是仪器，仪器会过期。** 固定的 golden set 随语料增长覆盖率下降，recall 数字的含义悄悄变化。语料显著增长时 golden set 要同步扩充（新语域、新语言分布），否则你在量一把越来越小的尺子。
3. **任何检索改动都走 eval 闭环关账，never 靠手感**（INV-6 永续）。改 K、换腿、加 rerank、换 embedding 模型——每次都重跑 golden set 前后对比，盯 A 层守卫（never 让新机制把已能命中的挤出去）。
4. **观测是飞轮的燃料。** FR-7 日志（query 长度、两腿名次、是否降级）是"观测 → golden set 飞轮"的原料：真实检索里反复捞不到的 query，就是下一批 golden set 条目。语料 / 流量上来后，把日志聚合成面板 / 周报。

## 运营杠杆与触发条件（休眠中，到点唤醒）

| 杠杆 | 触发条件 | 现状（2026-07-21） |
|------|----------|--------------------|
| rerank（cross-encoder / rerank API；rerankHook 槽位已就位） | eval 呈"recall 高、MRR 低"（货在 top-10 但排不到前） | 未触发（MRR 0.961，健康） |
| keyword 腿换 pg_trgm | AC-2 中文 recall 显著弱于英文 | 未触发（中文 0.926，vector 独力扛住） |
| HYBRID_CANDIDATE_K 精调 | eval + AC-7 P95 延迟共同驱动 | 未触发（K=50≈全库，超额保险） |
| brute-force → ANN（HNSW / IVFFlat） | chunks > 10,000 行 或 检索 P95 > 1s | 未触发（40 chunks，P95 1244ms） |
| 重切块（改 CHUNK_THRESHOLD / 参数） | 长文占比上升致单 chunk 语义坍缩 | 杠杆 = 手动 `UPDATE thoughts SET chunking_status='pending'`，级联重嵌（预算闸门兜底） |
| 换 embedding 模型 | 更强 / 更省模型出现 | 全库重嵌（向量空间不可混）；backfill 换模型识别已支持 |
| HyDE / 查询扩写 | B 层 recall 调参到顶后仍不达预期 | 未触发（B 层已 1.0） |
| 观测聚合（FR-7 日志 → 面板 / 周报 → 飞轮） | 真实检索量可观 | 未触发（流量小） |

## 运营节奏（语料增长时）

- **定期重跑 golden set 捕捉漂移**——不是等出问题，是主动体检。频率随语料增速定（现在月级足矣；快速增长期缩短）。
- **每次检索改动 = 一次关账**（前后对比 + A 层守卫 + 降级前置）。
- **G-2 单位效应盯梢**：长文 / 多 chunk 文档占比上升时，thought 级截断行为与当前不同、recall 分母变化——SPEC-07 已锚 thought 级，占比剧变时复查一次。
- **每次动检索层，回本文件问一句**：这次触发了哪条休眠杠杆？有没有长出新杠杆？

## 生长规则

仿 Control/13：任何运营中发现本表没覆盖的检索退化模式 → 回来加一行（杠杆 + 触发条件）；连续多轮"未触发"且想不出复发场景的，降级或删。**清单从运营中生长，不是博物馆。**

---

[SPEC-07 Hybrid 检索切换](../specs/SPEC-07-hybrid-search.md) · [SPEC-04 评估基建 — Golden Set 与检索指标](../specs/SPEC-04-eval-golden-set.md) · [13_设计压力测试清单](design-pressure-test.md) · 00_总览 - Build Your Own AI Brain
