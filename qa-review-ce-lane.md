# QA 深度代码审查 — C+E 线（Task 22 diff，~700 行）

- Task ID: 23-a · Agent: qa-reviewer (Z.ai Code)
- 审查对象：`git diff HEAD`（排除 .zscripts/dev.pid、db/custom.db、worklog.md）
- 方法：逐文件读源码 + 全项目 Node.status 写点 grep 推演 + mock/cluster 链路追踪 + 脚本实测（reset-demo 在 bun 下真实执行）+ `bunx tsc --noEmit` / `bun run lint` 复跑
- 结论速览：**P0 × 1，P1 × 2，P2 × 10**；10 项指定推演全部给出结论（见文末"已验证无问题"）

---

## P0（必须修）

### P0-1 · E1 看门狗 15min 上限与集群轮询车道 30/120min 上限直接冲突——真实集群长任务必然被误杀

- **文件**：`src/lib/workflow-engine.ts:629-632`（`NODE_TIMEOUT_MS` 默认 15min）+ `workflow-engine.ts:652-685`（`executeNodeGuarded` race）；对照 `src/lib/run-utils.ts:636`（集群轮询 deadline：非 alphafold 30min、**alphafold 120min**）与 `run-utils.ts:560-640`（`executeCompToolOnCluster` 的同步轮询循环）
- **问题**：`executeNode` 的 alphafold/comptool 集群分支（`_cluster` param）在 `executeCompTool` 内部**同步轮询到终态**，deadline 为 30/120 分钟（`run-utils.ts:636` 注释明示"Real AF2 predictions legitimately take hours"）。`executeNodeGuarded` 在 15 分钟先行 resolve `failed`：
  1. runner / 单节点 lane 的条件持久化把节点落定为 failed（此时远端作业还在正常跑）；
  2. 输家 promise 继续轮询到 30/120min ceiling，返回的 `pollCeiling`/终态被 `where status="running"` 的 updateMany **合法丢弃**；
  3. 节点已是 failed → stream 路由的 cluster reconcile（只作用于 running 节点）永不回写 → **远端作业的真实输出与 ToolJob completed 永远到不了节点**。
- **影响**：所有真实集群长任务（AF2 尤甚，100% > 15min）确定性失败；demo/mock-cluster 任务秒级完成，e2e 测不出。看门狗注释"poll-ceiling cluster submissions return 'running' on their own, they don't hold the lane"是错误假设——只有到达 30/120min ceiling 才返回，此前 lane 一直被占用。
- **修复建议**（任选）：
  - 集群分支豁免看门狗（cluster 车道已有自己的 per-tool ceiling + poll honesty，本就是被保护对象）；
  - 或 `executeNodeGuarded` 的超时取 `max(NODE_TIMEOUT_MS, 该工具的集群轮询 ceiling)`；
  - 或把集群 dispatch 改为"提交即返回 running"（与 stream reconcile 的既有设计对齐），彻底不占 lane。保留 `FOUNDRY_NODE_TIMEOUT_MS` 只覆盖本地引擎。

---

## P1（应修）

### P1-1 · SSE stream 路由的 cluster reconcile 是**无条件** `db.node.update`——E4 条件持久化覆盖面漏洞（TOCTOU 复活窗口）

- **文件**：`src/app/api/workflow/nodes/[id]/stream/route.ts:129-176`（写入点 `163-174`）
- **问题**：`reconcileClusterOutcome` 用**内存中刚读到的** `nodeRow.status === "running"`（:132）做守卫，随后 `db.node.update({ where: { id } , … status: nodeStatus, progress: 100, completedAt })` **无 DB 级条件**。在 `findUnique`（:183）与 `update`（:163）之间若用户 Stop（或看门狗/另一 lane）已把行翻成 failed，这次写入会把已中止节点**复活为 completed**（连同 result/logs/progress 100），直接违背 E4"stop 落定不可复活"的承诺。窗口虽小（毫秒级），但这是本轮明确要收口的不变量，且修法一行。
- **修复建议**：改为 `updateMany({ where: { id, status: "running" }, data })` 并按 `count===0` 放弃回写（保持 SSE 只读服务端真相）。

### P1-2 · Stop 只翻 DB 行，不取消底层集群作业——远端作业、轮询循环、SSH sweep 全部继续烧资源

- **文件**：`src/app/api/workflow/nodes/[id]/stop/route.ts:45-56`；对照 `src/lib/cluster/cluster-run.ts`（已有 `stopClusterJob`：slurm scancel / 进程组 kill）、`src/lib/run-utils.ts:638-641`（输家轮询循环每 3s 继续调 `reconcileClusterJobs()` 打 SSH）、`src/lib/cluster/cluster-run.ts:116`（sweep 持续更新 ToolJob）
- **问题**：对 running 节点 Stop 后：(a) 远端集群作业继续跑（占 GPU/队列）；(b) `executeCompToolOnCluster` 的轮询循环继续每 3s 一次 SSH 批量 sweep，最长到 30/120min deadline；(c) runner 的 worker lane 继续被占用直到引擎 settle 或看门狗（Stop 并不释放 lane）。基础设施（`stopClusterJob`）已存在且 Cluster 面板的 job UI 已在用，节点级 Stop 却没接。
- **影响**："看得见也管得住"只管住了 DB 行，没管住真实计算资源；节点 failed 与 ToolJob completed 的割裂也随之放大（见 P2-7）。
- **修复建议**：stop 路由在翻行成功后，用 stream 路由同款 `clusterJobIdFromLogs(node.logs)` 提取 jobId，best-effort 调 `stopClusterJob(jobId)`（失败不影响 200 响应）；可选：给轮询循环加取消信号（ToolJob 行变 cancelled 时轮询提前退出——sweep 已经会把远端 kill 后的行置 cancelled，循环读到即返回）。

---

## P2（可选）

1. **E2/E4 spinner 无超时兜底** · `src/components/panels/runs-sheet.tsx:213-219, 249-280, 285-314` — retry 的解锁 effect 只在 3s 轮询"找到且非 failed"时解锁；若重试节点被删除（行在任何 lane 都找不到）或 fetch 长挂（run lane 一直未返回），`retryingId`/`stoppingIds` 的 spinner 要等 POST finally 才清。建议给 row-missing 情形加 2-3 轮轮询后解锁，或 fetch 加 AbortController 超时。
2. **组卡拖拽"下轮轮询自愈"承诺不成立（静止态）** · `sweep-group-card.tsx:186-208` + `src/app/page.tsx:233-255` — 3s 轮询仅在**存在 running/pending 节点**时工作（page.tsx:238-241 busy 检查）；全组终态时 PATCH 失败的位置**不会被自愈**，只能靠刷新/下次运行（toast 文案"next refresh"尚诚实，代码注释"self-heal on the next 3s status poll"不准确）。且与 node-card 不同没有本地回滚（node-card.tsx:313-326 有 `upsertNode({...node})` 回滚）。建议失败时本地回滚成员位置。
3. **组卡拖拽契约与 NodeCard 的三处偏差** · `sweep-group-card.tsx:118, 132-150, 178-185` — (a) 排除列表少了 `[role='button']` 与 `[contenteditable='true']`（组卡内当前没有此类元素，属前瞻性一致性）；(b) pointermove 直接写 style，无 NodeCard 的 rAF 节流（单元素无碍，纯一致性）；(c) 提交用拖拽开始时渲染闭包里的整份 member NodeDTO 经 `mergeNodes` 全字段覆盖——拖拽中若 3s 轮询更新了成员 status/result，会被旧快照暂时回写（running/pending 回写会重启 busy 轮询自愈，completed→failed 回写在全静默组下不自愈）。建议只提交 `{id, x, y}`（mergeNodes 场景按字段挑选）。
4. **runner catch 路径是遗留的无条件 Node.status 写点** · `src/lib/workflow-runner.ts:229-239` — `db.node.update({ where:{id}, status:"failed" })` 无 status 条件（E4 清扫遗漏）。实际良性（只会再写一次 failed + 刷新 completedAt，不会复活 completed/覆盖 result/logs），但既然本轮立了"所有执行通道条件化"的不变量，建议同改 `updateMany where status="running"`。
5. **C2 深链把"列表加载失败"误报为"Screening not found"** · `src/components/panels/screening-panel.tsx:173-197`（配合 :143-171）— 初始 list 请求失败时 `listLoading=false, screenings=[]`，消费 effect 走 `!exists` 分支弹破坏性 toast 且不跳转。建议区分"列表为空/加载失败"。次要：挂载时先自动选中 list[0] 再被深链改选，多一次 detail 请求（外观级）。
6. **C3 非终态恢复携带残留 progress** · `src/app/api/workflow/nodes/route.ts:121-131` — 恢复 `idle`/`pending` 时保留快照 progress（如 40/100），出现"idle 但 progress 40"、以及"快照 running→idle + 旧 progress"的组合。建议非 completed 恢复强制 progress=0。另：恢复 `pending` 会被 Run Workflow / 单节点 BFS 级联拾起执行——语义可辩护（"重新排队"）但建议在 tutorial 的 undo 小节写明。
7. **Stop/看门狗后 Node 与 ToolJob 状态永久割裂** · `stop/route.ts:48-56` + `run-utils.ts` cluster lane — 节点 failed、ToolJob 稍后 completed（Cluster 面板可见"成功作业"，输出文件已同步到 outputs/ 但不再挂到节点）。属"迟到结果弃置"语义的固有代价且已文档化；可选改进：stream/cluster 面板对"job completed after node stopped"给出提示性 badge。
8. **demo DB 提交卫生** · `db/custom.db`（已跟踪+已修改）+ `db/demo-baseline.db`（新文件将入库） — 两个二进制都会随 dev 会话/`demo:snapshot` 持续变动，工作树将长期带脏 diff。建议 `.gitignore` 掉 `db/custom.db`、只跟踪 baseline（或双 ignore + release 流程）；README 快速开始里 `bun run demo:reset      # 恢复为演示基线（覆盖白 db/custom.db）` 的"覆盖白"是错字。
9. **（预存，非本轮引入）单节点 run lane 的快照缺失分支可抛 P2025** · `src/app/api/workflow/nodes/[id]/run/route.ts:112-120` — 节点行在 claim 后被并发删除时 `db.node.update` 抛 record-not-found → 整个 POST 500。可改 `updateMany`（count=0 → 返回 "failed"）。
10. **文档措辞：Stop 的"解锁下游"是延迟生效** · `README.md`（E 行 stop 描述）、`docs/tutorial.md` 6.10、`stop/route.ts:24`（STOP_NOTE）— 对 **running** 节点 Stop，runner lane 里的下游要等在飞引擎 settle（最多到看门狗 15min）才解锁；只有 queued(pending) 节点是立即跳过+解锁。建议措辞改为"排队节点立即取消；运行中节点落定后下游按失败语义继续"。

---

## 已验证无问题（10 项指定推演结论）

1. **E1 看门狗竞态（迟到写入路径）**：`executeNode` 自身**不写 Node 行**——全项目 grep 证实其唯一 DB 副作用是集群车道 `db.toolJob.create`（`run-utils.ts:579`）与 sweep 的 `db.toolJob.update`（`cluster-run.ts:116`）；输家 promise 的迟到写入只影响 ToolJob。Node 行只由调用方落定，两条执行 lane 均已条件化（`workflow-runner.ts:197/204`、`run/route.ts:132/140`），故"迟到引擎结果复活节点"在执行通道上不可达。`void execution.catch()` 防了 unhandled rejection，`finally clearTimeout` 防了计时器泄漏。**结论：竞态本身闭环（Node/ToolJob 割裂记 P2-7；真正的问题是 P0-1 的超时值冲突）。**
2. **E4 条件持久化覆盖面**：全量 Node.status 写点清单——runner `:96`(idle→pending) / `:159`(claim) / `:197` / `:204`；单节点 run `:43/:55/:101`(claim) / `:132` / `:140`；stop `:48`——**全部条件化**。scheduler 走 `runWorkflowById`（同 lane，`scheduler.ts:80`）；mock-cluster 不触 Node 表；例外仅：stream reconcile（**P1-1**）、runner catch（P2-4，良性）、nodes PATCH `status` 是用户直写通道（`nodes/[id]/route.ts:51-65`，预存、带枚举校验，非执行通道）、`instrumentation.ts:64` 仅 boot 一次性。
3. **Stop 与并行 runner 的交互**：pending 被标 failed 后 worker claim `count=0` → `runNode` 直接 return → `finally` 仍执行 `inFlight--` + 下游 `indeg--` + `pump()/settle()`（`workflow-runner.ts:240-255`）——池正常排空、下游按"失败不剪枝"解锁；`completedCount` 仅在 `persisted.count>0` 时累加（`:214`），run 汇总不会虚报。**结论：正确（running 节点的 lane 释放延迟已记 P2-10 措辞）。**
4. **E2 retry effect**：无无限循环——`setRetryingId(null)` 是单向终态，effect 在 `retryingId=null` 时 early-return；依赖 `[data, retryingId]` 无 stale closure；行未找到时由 POST 的 `finally` 兜底解锁（挂死窗口极窄，记 P2-1）；claim 失败 409 仍 toast；POST 完成后 reconcile 一次 `/api/runs`。
5. **E3 拖拽**：(a) 根元素 `role="group"`，排除选择器 `button, a, input, select, textarea` 从卡片 body 触发 `closest()` **不会匹配卡片自身**（group 不在选择器内）——卡体可拖、Compare/Expand 是真实 `<button>` 被排除、其 click 不会被 pointer-capture 吞（node-card 同款教训的修复模式成立）；(b) `pointerup !moved` → 展开，替代了被删除的 onClick，按钮点击不会误触发展开（pointerdown 已早退，dragState 为 null）；(c) `onPointerCancel` 复位且不提交；(d) `mergeNodes` 是 zustand 单次原子 `set`（整批成员一个不可变快照），React 18/19 并发渲染经 useSyncExternalStore 取一致快照，**无撕裂**；(e) 提交后 `deriveSweepGroups` 用新坐标重算 `g.x/g.y`，卡片 `left/top` 更新与 transform 清除同帧落位，无视觉跳变；minimap/band-select 均基于可见节点集，不受影响。
6. **C3 API 安全**：status 白名单 4 态（`running` 显式拒绝→idle，`nodes/route.ts:22,95-98`）；progress `Number.isFinite` + 0-100 钳制（NaN→null→0）；result/logs `typeof string` + 256KB 截断；Date 解析失败回退 `new Date()`；completed 强制 progress=100。无注入/无非法态可写入。恢复 `pending` 会被 `runWorkflowById` 的 runnable（pending/idle）拾起——与 idle 在 BFS 级联/Run Workflow 下行为**完全一致**（单节点 lane 的级联同样捡 idle），故非新风险；语义="撤销删除后重新排队"，可接受（建议文档化，记入 P2-6）。history-apply 重建同时携带 sweepGroup + 终态（`history-apply.ts:144-159`），redo 后组卡/Compare/一键 campaign 均可解析。
7. **C2 深链时序**：panel 条件挂载（`page.tsx:359`）两种顺序均闭环——(a) 先设 `pendingScreeningId` + `setActivePanel("screening")`（zustand 同步，React 批量渲染后 panel 挂载时 id 已在 store）→ 初始加载 `listLoading=true` 时消费 effect early-return → 列表到达 `listLoading=false` → 消费 + `setCurrentId(target)`；(b) panel 已挂载列表已载：effect 直接消费。`setPendingScreeningId(null)` 在 effect（commit 后）中调用，安全；消费即清空，`screenings` 引用再变也不会重复消费（id 已 null）。
8. **stop 路由细节**：`node.logs` 为 null → `"" + STOP_NOTE`，结果为 `"\n[stop] …"`——仅多一个前导换行，无异常；409 双守卫的 TOCTOU 由**条件 updateMany**（`where status in running/pending`）+ `count===0 → 409` 原子封死；与 running→running 的 poll-ceiling 持久化（同样条件化）竞争时最多以稍旧 logs 覆盖一次，外观级。
9. **demo reset 脚本**：`node:readline/promises` 在 bun 下**实测可用**（管道输入 `n` → "Aborted — nothing changed." exit 0；`--force` 路径正确）；`fileURLToPath` 解析 `../db/custom.db` 相对脚本位置正确；两模式 404 兜底齐全；reset 往返 `cmp` 验证 `custom.db` 与 `demo-baseline.db` **byte-identical**（snapshot→reset 幂等）。提交卫生问题记 P2-8。
10. **交叉回归**：框选只命中 `visibleNodes`（组卡不在其中，无法被框选——与"组卡不可选中"一致）；NodeGroupLayer 组框 bbox 与计数只用可见成员（全折叠组消失；`nodeIds` 改写仅是本地渲染副本，不回写 group store）；layoutNodes 的 `g.x/g.y` 成员映射在拖拽提交后由 `deriveSweepGroups` 重算，边锚点随之正确迁移（拖拽中不实时重画边——注释已声明，外观级）；1 成员残余组自动"退折叠"（`deriveSweepGroups` ≥2 门槛使 lone variant 重新可见，`collapsedMemberIds` 只含 ≥2 组）；history-apply 的 C3 字段与 sweep 变体重建正交（同一次 POST 同时带 sweepGroup + status，服务端两路校验互不干扰）。

---

## 复跑验证（审查环境实测）

- `bunx tsc --noEmit` → `src/` **零错误**（唯一含 "src/" 的报错来自 `skills/stock-analysis-skill/src/analyzer.ts`，预存、按惯例忽略）。
- `bun run lint` → **零输出零告警**。
- `bun scripts/reset-demo.ts`（usage/确认流程/piped stdin）实测通过。

## 建议下一步

1. 先修 **P0-1**（集群车道豁免或上限取 max）——这是唯一会确定性破坏已交付功能的项；修后用 `FOUNDRY_NODE_TIMEOUT_MS=5000` + mock-cluster 慢作业做一次真实看门狗 e2e。
2. **P1-1** 一行改动（updateMany 条件化）随下个 commit 收口；**P1-2** 按需排期（stopClusterJob 接线 + 轮询循环读 cancelled 提前退出）。
3. P2-2/P2-3（组卡拖拽回滚与字段挑选）与 P2-5/P2-6 可打包进下一轮交互打磨；P2-8 提交策略在本次 commit 前决策。
