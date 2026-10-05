# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep 系统全链路）与 2026-10-06（A 线
> Campaign 闭环 + QA/e2e）两轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **参数扫描（Parameter Sweep / Campaign Mode）**：Inspector 的 Sweep 按钮一键把工具节点
  参数网格（笛卡尔积，≤24 组合）展开为变体节点——继承上游连线、命名带 `k=v` 标签、网格
  布局、单次 Ctrl+Z 整组撤销。全链路 e2e 验证：`num_designs` / `total_length` 真实反映到
  输出文件数与残基数，输出进入 Screening 评估。
- **A 线 · Campaign 体验深化（本轮交付）**：
  - **A1 Sweep 结果对比视图**：变体节点（卡片带 `sweep` 徽标）→ Inspector **Compare** →
    只读对比表（`GET /api/workflow/nodes/:id/sweep-group`）：参数轴列 + 逐变体聚合指标
    （与筛选收割同一提取规则：designs[] 均值 / RAW_KEY_MAP / ranking_debug）、列内最优
    高亮、默认权重综合分 + **Best** 榜冠、行点击定位画布节点；指标列方向箭头 + 域值。
  - **A2 Sweep → Screening 一键衔接**：对比视图 **Create screening campaign**（`POST
    /api/screening {source:{kind:"sweep"}}`）收割全部已完成变体，运行标签 = 变体名
    （候选名 `变体名/design_N` 自带溯源），参数轴绑定权重预设（total_length → 几何加权、
    sampling_temp → 多样性加权…）；rescan 支持按组重建。
  - **A3 参数轴模板**：Sweep 对话框内置 6 个阶梯模板（设计数 / 长度 / 采样温度 / recycle /
    对称体系 / LLM 温度），按节点参数 schema 自动匹配（min/max/options 校验）一键填入。
  - **sweepGroup 数据链路**：Node.sweepGroup 列 + 索引；create API / 版本快照恢复 /
    undo-redo（history-apply 重建时传递）全链路保持组链接——redo 后 Compare 依然可用。
- **QA 修复（本轮实测发现）**：
  - **跨工作流撤销污染（严重）**：切换工作流后 Ctrl+Z 会把旧工作流的快照重放到新工作流
    （DB 跨图建删节点）。双修复：`setWorkflow` 检测工作流 id 变化时清空历史栈 +
    历史捕获订阅忽略工作流切换事件。
  - 对比表在窄屏不可滚动（Radix ScrollArea viewport 被子内容撑宽）→ 改用与筛选表一致的
    `overflow-x-auto` + `min-w` 方案，375px 实测可滚动。
  - redo 并行重建打乱变体创建顺序 → 对比表按参数轴数值排序（数值感知）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | Sweep 输出真实反映参数（文件数 ∝ num_designs，残基数 = total_length） | 批量实验设计闭环成立 | 已交付 A1/A2/A3 |
| 2 | 对比视图 Best 行与手工评分一致（v4/100 = 77.9 分） | 结论可信 | — |
| 3 | 画布节点位置重叠（同源两次 sweep 网格同位叠放） | 点击困难、误选 | B2 |
| 4 | Run All 串行执行变体（4 变体 ≈ 30s） | 大 sweep 时等待久 | B3 |
| 5 | 演示 DB（14 节点）与 README 文档（6 节点）不一致 | 文档可信度 | C1 |
| 6 | undo 恢复的删除节点在服务器端为 idle 状态（已记录的已知限制） | 轻微状态偏差 | C3 |
| 7 | 首次 db:push 后 dev server 需重启才能识别新列（stale Prisma client） | 部署/运维体验 | C4（文档化） |

## B 线 — 画布与执行引擎（P0，下一阶段建议）

1. **自动布局防重叠**：新建 / sweep / 导入节点时做占用检测，位置冲突自动偏移（实测发现
   #3：同源两次 sweep 的变体网格完全同位叠放）。
2. **并行执行通道**：无依赖的变体节点并行运行（内置引擎并发上限 3–4），cluster 模式下
   分散到多 GPU。
3. **Sweep 结果聚合卡片**（node-group 扩展）：变体组折叠为一张组卡（进度 = 完成数 /
   总数），点击展开——大 sweep 不淹没画布，组卡直接挂 Compare 入口。
4. **运行队列可视化**：全局 Runs 视图（跨工作流），失败节点一键重试。

## C 线 — 数据与可信度（P1）

1. **演示数据治理**：IL-7Rα 战役整理为正式演示工作流（更新 README 界面一览与教程
   截图），或提供 "Reset demo data" 种子脚本。
2. **实验溯源（Provenance）深化**：变体 → 输出文件 → 筛选候选 → promote 节点的完整
   血缘链（候选详情已带变体标签，补 promote 回写与参数来源徽标）。
3. **undo 状态语义补齐**：create API 接受可选 status 字段，使 undo 恢复的节点保留
   快照状态而非恒为 idle。
4. **运维文档**：schema 变更后需重启 dev server（stale Prisma client）写入贡献指南。

## D 线 — 科研深度（P2，探索性）

1. **3D 叠合比较**：筛选详情支持两候选叠合（RMSD + 差异着色），复用 molecular/superpose；
   对比视图行选两列 → 直接叠合。
2. **抗体亲和力成熟链路**：RFantibody → MPNN 串联的 shotgunning + 阶梯式 CDR 突变扫描。
3. **认证与团队协作**（NextAuth）：工作流 / campaign 共享，操作审计。
4. **Sweep 结果导出**：对比表 CSV / 报告（复用 screening CSV 底座）。

## 验收标准（延续本阶段做法）

- 每项新功能必须：API 冒烟（无效输入全 400）+ 浏览器 e2e（真实引擎、真实输出、
  可用文件级证据验证）+ undo/redo DB 一致性检查。
- 跨工作流操作（切换 / 导入 / 恢复快照）后必须显式验证撤销栈不串图（本轮发现 #1 的
  教训：历史栈是全局单栈，任何"换图"路径都要过一遍）。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  演示 DB 与文档一致。
