# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-08（C 线数据可信度 + E 线执行健壮性）及此前
> Sweep/A 线/B 线三轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **E 线 · 执行健壮性与交互打磨（本轮交付）**：
  - **E1 executeNode 看门狗**：`node-lifecycle.ts` 统一执行生命周期——
    Promise.race 判别联合超时（本地 lane 15min，`NODE_TIMEOUT_MS` 可覆盖；
    cluster 路由节点豁免 150min 楔死保险）；超时节点标 failed + 解锁下游，
    pool 永不楔死。e2e 实证：8.2s 返回、并行 lane 存活、下游解锁、
    **晚到引擎结果被条件写回丢弃（45s 后仍 failed）**。
  - **E4 全局运行中止**：`POST /api/runs/abort`（nodeId/workflowId 二选一）→
    running/pending 标 failed "Aborted"；RunsSheet active 行 Stop 按钮 +
    Running&Queued 区 Stop all（按 workflow 批量）。e2e 实证：运行中 Stop
    立即生效 + toast + 节点迁入 failed lane + 40s 后不被晚到结果复活。
  - **E2 Retry 即时反馈**：RunsSheet Retry 改 fire-and-forget——toast 即时、
    spinner 仅覆盖 claim 阶段、3s 轮询接管呈现 running 态。
  - **E3 组卡可拖拽**：折叠组卡 pointer 拖拽（node-card 同契约：capture +
    transform + zoom 换算）→ 一次历史快照 + N upsert + N PATCH；CDP 真实
    拖拽实测整组 (30,60)→(230,180) 持久化、Ctrl+Z 单次恢复整组。
    折叠一致性收尾：NodeSearch / NodeGroupLayer 过滤折叠成员。
- **C 线 · 数据与可信度（本轮交付）**：
  - **C2 实验溯源**：promote 节点 params.source 结构化血缘块（screening
    id/name/sourceLabel/candidates/promotedAt）+ Inspector GitBranch 溯源
    徽标（`openScreening` 跨面板深链：徽标点击 → Screening 面板 + 对应
    campaign 打开，实测闭环）。
  - **C3 undo 状态语义**：nodes POST 接受可选 snapshot 块（status/progress/
    result/logs，枚举校验 + 1MiB 上限 + running/pending coerce idle）；
    history-apply 恢复删除节点携带快照——实测 promote 节点删除后 Ctrl+Z
    恢复仍 completed + result + source 全保留。
  - **C5 sweep 依赖语义**：Sweep 对话框明示"变体继承源入边，无上游时为
    独立根并行执行"。
  - **C4 运维文档**：docs/CONTRIBUTING.md（db:push 后重启 dev server 的
    症状/根因/修复 + 代码约定 + 环境限制）。
  - **C1 演示数据治理（文档侧）**：README 移除硬编码节点数（与活 DB 矛盾），
    补 /api/seed 幂等重置指引。
- **QA 修复（本轮实测/审查发现）**：
  - **P0：SSE poll-ceiling reconcile 无条件写回复活已中止节点**（QA 审查
    发现，qa-review-c-e-lane.md）：用户 Stop 落在 reconcile 读与写之间时，
    已 abort 的 cluster 节点被覆盖回 completed。修复：条件 updateMany
    （where status=running）——条件写回契约收编**第三条 lane**。
  - P1：`isClusterRoutedNode` 用引擎同款 `extractClusterTarget`（`_cluster:""`
    不再误判 cluster 而失去 15min 看门狗）；RunsSheet Row onKeyDown 事件
    来源守卫（聚焦 Stop/Retry 按 Enter 不再被行吞掉触发误导航）。
  - P2：nodes POST params 1MiB 上限；快照恢复 pending coerce idle（防复活
    排队态无人认领）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | 看门狗 e2e：8s 超时 → pool 8.2s drain、下游解锁、晚到结果不复活 | E1 语义闭环 | 已交付 |
| 2 | abort e2e：Stop 即时 failed、40s 后不被晚到引擎/后台 lane 复活 | E4 语义闭环 | 已交付 |
| 3 | **条件写回契约必须覆盖所有写节点状态的 lane**：runner/单节点 run 之外，SSE reconcile 是第三条（P0 教训） | 任何新增执行/同步 lane 都要走 node-lifecycle | 验收标准 |
| 4 | abort 不 kill 远端 cluster ToolJob（本地 failed ≠ 远端停止） | 远端作业仍在跑、消耗配额 | F1 |
| 5 | Retry 的 route 仍同步等待（语义被其他调用方依赖）；fire-and-forget 只在 UI 层 | route 层异步化需独立设计 | F2（P3） |
| 6 | CDP 拖拽需 --duration ≥150ms 才可靠触发 click 派发（短 duration 点击落空） | e2e 工程经验 | 验收标准 |
| 7 | 组卡拖拽中边不实时跟随（松手重算）；NodeGroupLayer 彩色组框在组拖拽后按成员新位置重算 | 轻微视觉延迟 | 可接受 |
| 8 | promote 恢复节点（undo）后 refId=screening id 保留，但新节点 id ≠ 原节点（历史 apply 契约） | 下游边按 id 重连已处理 | 已闭环 |
| 9 | agent LLM 节点超时（15min 看门狗）只能标 failed，无法主动取消进行中的 SDK 请求 | 长会议/研究节点取消需要 AbortSignal 深入执行层 | F3 |
| 10 | SSE reconcile 的 cluster 场景未真实 SSH 实测（条件写语义与 abort 同路径已被两条 lane 实证） | 验证覆盖缺口 | F4（P2） |
| 11 | screening detail 未反向展示"promoted 到哪些节点"（refId 可查但未暴露） | 溯源链 UI 只单向（节点→筛选） | F5（P3） |
| 12 | 演示 DB（14 节点）与文档不再硬编码计数（C1 修复）；sweep 语义已明示（C5） | 文档可信度 | 已闭环 |

## F 线 — 执行可控性与溯源闭环（P1，下一阶段建议）

1. **远端 cluster 作业联动中止**：RunsSheet Stop 对 cluster-routed 节点
   一并 cancel ToolJob（复用 cluster 面板 job 取消 lane），本地 failed 与
   远端 cancelled 一致（测试结论 #4）。
2. **AbortSignal 贯通执行层**：node-lifecycle 注册 per-node AbortController，
   传入 executeCompTool/runAgentTurn——abort 即时打断 spawn（kill）与 LLM
   SDK 请求，而非等看门狗（测试结论 #9）。
3. **运行历史归档**：ToolJob/节点终态滚动清理 + Run history 视图（超过 48h
   窗口的运行可追溯）。
4. **SSE reconcile 真实 cluster e2e**：接一次 SSH 目标（或 mock cluster
   connection）验证 poll-ceiling → abort → reconcile 丢弃（测试结论 #10）。
5. **溯源链反向展示**：screening detail 列出 promote 节点（refId 查询），
   形成"筛选→画布"双向导航（测试结论 #11）。

## D 线 — 科研深度（P2，探索性）

1. **3D 叠合比较**：筛选详情支持两候选叠合（RMSD + 差异着色），复用
   molecular/superpose；对比视图行选两列 → 直接叠合。
2. **抗体亲和力成熟链路**：RFantibody → MPNN 串联的 shotgunning + 阶梯式
   CDR 突变扫描。
3. **认证与团队协作**（NextAuth）：工作流 / campaign 共享，操作审计。
4. **Sweep 结果导出**：对比表 CSV / 报告（复用 screening CSV 底座）。

## QA 遗留（P2/P3，体验优化）

- 组卡拖拽实时边跟随（LiveWire 消费组卡 live-drag 状态）。
- Retry route 层异步化（fire-and-forget API 或 SSE 完成事件，测试结论 #5）。
- ScreeningPanel 深链失败静默（pendingScreeningId 不在列表时仅清空）——
  加 toast 提示。
- node-search/node-group 的 deriveSweepGroups 在大图重复计算（memo 已缓存，
  超大图可提升为 store 派生）。

## 验收标准（延续本阶段做法）

- 每项新功能必须：API 冒烟（无效输入全 400）+ 浏览器 e2e（真实引擎、真实
  输出、可用文件级证据验证）+ undo/redo DB 一致性检查。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（B 线教训：
  setPointerCapture 会吞掉派生 click，JS click() 测不出这个问题）。
- **CDP 鼠标操作 duration ≥150ms**（C 线教训：短 duration 的 move+click
  组合会丢失点击派发，e2e 工程标准）。
- **任何写节点状态的新 lane 必须走 node-lifecycle 条件写回**（P0 教训：
  绕过契约的旁路 lane 会复活已中止节点，测试结论 #3）。
- 跨工作流操作（切换 / 导入 / 恢复快照）后必须显式验证撤销栈不串图。
- 移动端 375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无
  运行时错误、演示 DB 与文档一致（节点/边计数 + screening 基线）。
