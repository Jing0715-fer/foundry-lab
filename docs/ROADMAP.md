# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep 系统）、2026-10-06（A 线闭环）与
> 2026-10-07（B 线画布与执行引擎）三轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **参数扫描（Parameter Sweep / Campaign Mode）**：Inspector 的 Sweep 按钮一键把工具节点
  参数网格（笛卡尔积，≤24 组合）展开为变体节点——继承上游连线、命名带 `k=v` 标签、
  单次 Ctrl+Z 整组撤销。全链路 e2e 验证：`num_designs` / `total_length` 真实反映到
  输出文件数与残基数，输出进入 Screening 评估。
- **A 线 · Campaign 体验深化**：Sweep 结果对比视图（Best 榜冠/列内最优高亮）、
  Sweep → Screening 一键衔接（参数轴权重预设/变体名溯源）、6 个参数轴阶梯模板、
  sweepGroup 数据链路（undo/redo 保组）。
- **B 线 · 画布与执行引擎（本轮交付）**：
  - **B1 自动布局防重叠**：sweep 变体网格锚点做块级 AABB 占用检测，冲突整块下移
    （两次 sweep 同源实测 y=310/640 完全错开）；`findFreeSpot` 螺旋搜索统一到
    `canvas-utils.ts` 共享（palette/command-palette/canvas 三个 drop 入口 + 出界候选
    过滤），9 节点程序化 AABB 验证零重叠。
  - **B2 并行执行通道**：`workflow-runner.ts` 重写为 Kahn 入度调度 + 事件驱动
    worker pool（MAX_CONCURRENCY=3），保留原子 claim / poll-ceiling 诚实语义 /
    失败不剪枝（与串行版语义对齐）。`POST /api/workflow/run` 响应新增
    `peakConcurrency`（header toast 展示 "N parallel lanes"）。实测：3 节点同毫秒
    启动、peakConcurrency=3、墙钟 17.3s（串行需 ~35s）、num_designs 1–8 全部真实
    反映到 PDB 文件数。
  - **B3 Sweep 聚合组卡**：变体卡 sweep 徽标点击 → 整组折叠为一张组卡（进度条 =
    完成数/总数、状态 pill、Compare 入口、Expand），点击组卡展开；折叠时
    EdgesLayer/LiveWire/minimap 成员位置映射到组卡锚点（边视觉聚合、无悬空线）。
    纯 UI 状态（不进 DB），undo/redo 零影响。
  - **B4 运行队列可视化**：`GET /api/runs` 跨工作流队列（active/failed/recent/
    summary，查询级 select 防 3s 轮询读放大）+ header Runs 按钮（running 徽标）+
    RunsSheet（打开时 3s 轮询、失败行 Retry 复用单节点 run lane 的 claim+级联、
    行点击跳转工作流并选中节点）。
- **QA 修复（本轮实测发现）**：
  - **卡片交互元素被拖拽 pointer-capture 吞掉（严重，e2e 实测）**：node-card 的
    `onCardPointerDown` 无差别 `setPointerCapture`，导致卡内任何 button（sweep 折叠
    徽标等）的 click 被重定向到卡片永不触发。修复：pointerdown 时排除交互元素
    （button/a/input/select/[role=button]）。
  - sweep 网格上界从"事后 Math.min 截断"改为搜索循环条件（防把找到的空位拉回
    重叠区）；runs 查询 trim 到 select 级；RunsSheet 行改 div[role=button]（消
    button 嵌套）；框选只命中可见节点（防折叠组暗选+浮空删除条）。
  - 跨工作流撤销污染（上轮修复）回归验证通过；minimap 折叠一致性 + 悬空边修复。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | B2 并行实测 peakConcurrency=3、无依赖变体与源同毫秒启动 | 大 sweep 等待时间减半成立 | 已交付 B2 |
| 2 | sweep 变体只继承源节点入边：无上游源的变体是无依赖节点（并行执行） | 语义正确但用户可能误以为变体会等源输出 | C5（文档化） |
| 3 | 卡片内交互元素（button）被 pointer-capture 吞 click | 任何卡内按钮都点不动（本轮 sweep 徽标触发） | 已修复，验收新增"卡内 button 必须实测点击" |
| 4 | executeNode 无超时看门狗：单个引擎挂起会楔死整个 worker pool | 长会话可靠性 | E1 |
| 5 | RunsSheet Retry 的 await 贯穿整个节点执行（长任务按钮长时间 spinner） | 可接受但体验欠佳 | E2 |
| 6 | 组卡不可拖拽；NodeSearch/NodeGroupLayer 未过滤折叠成员 | 轻微不一致 | E3 |
| 7 | 演示 DB（14 节点）与 README 文档（6 节点）不一致 | 文档可信度 | C1（延续） |
| 8 | undo 恢复的删除节点在服务器端为 idle 状态 | 轻微状态偏差 | C3（延续） |
| 9 | 首次 db:push 后 dev server 需重启（stale Prisma client） | 部署/运维体验 | C4（延续） |

## C 线 — 数据与可信度（P1，下一阶段建议）

1. **演示数据治理**：IL-7Rα 战役整理为正式演示工作流（更新 README 界面一览与教程
   截图），或提供 "Reset demo data" 种子脚本。
2. **实验溯源（Provenance）深化**：变体 → 输出文件 → 筛选候选 → promote 节点的完整
   血缘链（补 promote 回写与参数来源徽标）。
3. **undo 状态语义补齐**：create API 接受可选 status 字段，使 undo 恢复的节点保留
   快照状态而非恒为 idle。
4. **运维文档**：schema 变更后需重启 dev server（stale Prisma client）写入贡献指南。
5. **sweep 依赖语义文档化**：变体继承源的入边——无上游源时变体作为独立根并行执行；
   在 Sweep 对话框与教程中明示（测试结论 #2）。

## E 线 — 执行健壮性与交互打磨（P1.5，本轮新增）

1. **executeNode 看门狗**：每节点执行超时（如 15min）标记 failed 并解锁下游，
   防 worker pool 被挂起引擎楔死（测试结论 #4）。
2. **RunsSheet Retry 即时反馈**：Retry 改 fire-and-forget（toast 已即时，spinner
   只覆盖 claim 阶段），依赖 3s 轮询呈现执行态（测试结论 #5）。
3. **组卡可拖拽 + 折叠一致性收尾**：组卡拖拽平移整组成员；NodeSearch 与
   NodeGroupLayer 过滤折叠成员（测试结论 #6）。
4. **全局运行中止**：Runs 视图 active 行加 Stop（节点级 + workflow 级），补齐
   "看得见也管得住"。

## D 线 — 科研深度（P2，探索性）

1. **3D 叠合比较**：筛选详情支持两候选叠合（RMSD + 差异着色），复用 molecular/
   superpose；对比视图行选两列 → 直接叠合。
2. **抗体亲和力成熟链路**：RFantibody → MPNN 串联的 shotgunning + 阶梯式 CDR
   突变扫描。
3. **认证与团队协作**（NextAuth）：工作流 / campaign 共享，操作审计。
4. **Sweep 结果导出**：对比表 CSV / 报告（复用 screening CSV 底座）。

## 验收标准（延续本阶段做法）

- 每项新功能必须：API 冒烟（无效输入全 400）+ 浏览器 e2e（真实引擎、真实输出、
  可用文件级证据验证）+ undo/redo DB 一致性检查。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（本轮教训 #3：
  setPointerCapture 会吞掉派生 click，JS click() 测试不出这个问题）。
- 跨工作流操作（切换 / 导入 / 恢复快照）后必须显式验证撤销栈不串图。
- 移动端 375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时
  错误、演示 DB 与文档一致。
