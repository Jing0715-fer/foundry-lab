# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05 的全量 QA + e2e 测试结论（参数扫描系统全链路验证 +
> 基线回归）制定，随每个阶段滚动更新。

## 本阶段成果（已完成）

- **参数扫描（Parameter Sweep / Campaign Mode）**：Inspector 的 Sweep 按钮一键把工具节点
  参数网格（笛卡尔积，≤24 组合）展开为变体节点——继承上游连线、命名带 `k=v` 标签、网格
  布局、单次 Ctrl+Z 整组撤销。全链路 e2e 验证：`num_designs` / `total_length` 真实反映到
  输出文件数与残基数，输出进入 Screening 评估。
- 回归验证：14 节点演示工作流、3 个筛选 campaign（Scaffold 60 / AF2 20 / Antibody Fv 6）、
  版本快照、定时运行、移动端布局全部正常；控制台 / dev.log 零错误。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | Sweep 输出真实反映参数（文件数 ∝ num_designs，残基数 = total_length） | 批量实验设计闭环成立 | A1、A2 |
| 2 | 演示 DB（14 节点）与 README 文档（6 节点）不一致 | 文档可信度 | C1 |
| 3 | 画布节点位置重叠（IL-7Rα Target 与 RFdiffusion） | 点击困难、误选 | B2 |
| 4 | Run All 串行执行变体（4 变体 ≈ 30s） | 大 sweep 时等待久 | B3 |
| 5 | 变体筛选需逐节点建 campaign | sweep → 筛选少一步自动化 | A2 |
| 6 | undo 恢复的删除节点在服务器端为 idle 状态（已记录的已知限制） | 轻微状态偏差 | C3 |

## A 线 — Campaign 体验深化（P0，最近 1–2 个迭代）

1. **Sweep 结果对比视图**：变体组完成后一键打开内联对比表——按参数轴分组的关键指标
   （plDDT / recovery / clashes），复用 Screening 的 compare 底座。让"扫参数"从
   "跑完再去看筛选"变成"跑完即出结论"。
2. **Sweep → Screening 自动衔接**：Run All 完成后提供 "Create campaign from this sweep"
   一步动作（把全部变体节点作为源，不再逐节点创建），并支持把参数轴绑定到权重预设
   （如 `total_length` 变体 → 几何指标加权）。
3. **参数轴模板**：常用扫描模板（长度系列、温度系列、design 数阶梯）一键填入，
   降低新用户门槛。

## B 线 — 画布与执行引擎（P1）

1. **Sweep 结果聚合卡片**（node-group 扩展）：变体组折叠为一张组卡（进度 = 完成数 /
   总数），点击展开——大 sweep 不淹没画布。
2. **自动布局防重叠**：新建 / sweep / 导入节点时做占用检测，位置冲突自动偏移。
3. **并行执行通道**：无依赖的变体节点并行运行（内置引擎并发上限 3–4），
   cluster 模式下分散到多 GPU。
4. **运行队列可视化**：全局 Runs 视图（跨工作流），失败节点一键重试。

## C 线 — 数据与可信度（P1）

1. **演示数据治理**：IL-7Rα 战役整理为正式演示工作流（更新 README 界面一览与教程
   截图），或提供 "Reset demo data" 种子脚本。
2. **实验溯源（Provenance）**：变体 → 输出文件 → 筛选候选 → promote 节点的血缘链
   （候选详情显示参数来源标签）。
3. **undo 状态语义补齐**：create API 接受可选 status 字段，使 undo 恢复的节点保留
   快照状态而非恒为 idle。

## D 线 — 科研深度（P2，探索性）

1. **3D 叠合比较**：筛选详情支持两候选叠合（RMSD + 差异着色），复用 molecular/superpose。
2. **抗体亲和力成熟链路**：RFantibody → MPNN 串联的 shotgunning + 阶梯式 CDR 突变扫描。
3. **认证与团队协作**（NextAuth）：工作流 / campaign 共享，操作审计。
4. **Sweep 结果导出**：CSV / 报告（复用 screening CSV 底座）。

## 验收标准（延续本阶段做法）

- 每项新功能必须：API 冒烟（无效输入全 400）+ 浏览器 e2e（真实引擎、真实输出、
  可用文件级证据验证）+ undo/redo DB 一致性检查。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  演示 DB 与文档一致。
