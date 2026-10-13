# QA 深度代码审查 — C 线（数据可信度）+ E 线（执行健壮性）

- 审查对象：Task 22 全部未提交改动（`git status`：16 个修改文件 + 3 个新文件
  `src/lib/node-lifecycle.ts`、`src/app/api/runs/abort/route.ts`、`docs/CONTRIBUTING.md`）
- 审查方式：逐文件精读 diff + 交叉验证调用方/竞态对象（workflow-runner 的 worker pool、
  单节点 run route 的 reclaimer、SSE stream route 的 poll-ceiling reconcile、
  store/history-apply 的 undo 契约、inspector/`extractClusterTarget` 的 cluster 判定）。
  **只审查，未修改任何代码。**
- 结论速览：**P0 × 1，P1 × 2，P2 × 11**。核心新模块 `node-lifecycle.ts` 的条件写回契约本身
  推演无漏洞（详见「已验证无问题」）；P0 出在**一条未接入该契约的既有写回 lane**（SSE
  reconcile）与新 abort 功能的交互上。

---

## P0（必须修：正确性/并发 bug）

### P0-1 SSE poll-ceiling reconcile 的无条件写回可以在用户 Stop 之后「复活」节点

- **文件**：`src/app/api/workflow/nodes/[id]/stream/route.ts:129-176`（竞态对象：
  `src/lib/node-lifecycle.ts:154-166` `abortNodeRun` / `src/app/api/runs/abort/route.ts:44`）
- **问题**：`reconcileClusterOutcome` 的序列是三步独立 DB 操作——
  `findUnique(node)`（读 status=running + logs 里的 `[cluster run · job <id>]` 标记）→
  `findUnique(toolJob)`（判 terminal）→ `db.node.update({ where: { id }, data: { status: nodeStatus, … } })`。
  最后一步**不带任何 status 条件**。若用户的 Stop 恰好落在两次读与写之间（Inspector 打开着
  该节点的 stream、poll 每 500ms 一轮、中间夹一个 ToolJob 查询，窗口为毫秒级），
  `abortNodeRun` 已把行翻成 `failed`（result="Aborted…"），随后 reconcile 的无条件
  update 会把它**覆盖成 completed/failed + 远端 stdout/logs**——abort 的终态被晚到的
  reconcile 结果覆盖，节点以远端结果「复活」。
  这正是 node-lifecycle 头注释第 2 条要防御的「late-result overwrite / resurrection」
  竞态类别：runner 与单节点 run route 两条 lane 都已接入条件写回，唯独这条 SSE lane 没有。
  （abort 会覆写 logs、丢掉 cluster 标记，所以「abort 之后新开的 poll」不会再 reconcile——
  暴露面仅限**正在 in-flight 的那一轮 poll**。）
- **影响**：低概率（毫秒窗口 × 500ms poll 对齐）但后果是数据可信度问题：用户明确中止的
  cluster 运行最终显示为 completed，Runs 面板/画布与事实相反——恰好击穿 C 线目标。
- **修复建议**（与 `persistExecOutcome` 同一契约，一行改动）：

  ```ts
  // stream/route.ts reconcileClusterOutcome 内
  const r = await db.node
    .updateMany({
      where: { id: nodeRow.id, status: "running" },   // 条件写回
      data: { status: nodeStatus, result, logs, progress: 100, completedAt: new Date() },
    })
    .catch(() => ({ count: 0 }));
  if (r.count === 0) return null;  // 已被 abort/翻终态 —— 丢弃本轮 reconcile，按 DB 现状收流
  ```

---

## P1（应修）

### P1-1 `isClusterRoutedNode` 与引擎的 cluster 判定不一致：`_cluster: ""`（已清除）被误判为 cluster 路由

- **文件**：`src/lib/node-lifecycle.ts:53-58`；对照 `src/lib/run-utils.ts:463-477`
  （`extractClusterTarget`：空串/坏 JSON/缺 connectionId 一律 null → 本地执行）与
  `src/components/canvas/inspector.tsx:432`（清除 cluster 目标时持久化 `onPatchParam("_cluster", "")`）
- **问题**：`isClusterRoutedNode` 只检查 `_cluster !== undefined && _cluster !== null`。
  Inspector「清除」写入的是**空字符串** —— 引擎侧视为本地 lane（15min 看门狗适用对象），
  而看门狗选择器却判它为 cluster 路由 → 套用 **150min** 楔死保险。同理，`_cluster` 是缺
  `connectionId` 的 JSON 串时两边结论也不一致。
- **影响**：清除过 cluster 目标的（实际本地执行的）工具节点一旦引擎挂起，要 150 分钟才会被
  看门狗判失败（本应 15 分钟）；E1 的保护对这类节点形同虚设。看门狗不是策略错杀（那是把
  cluster 作业当本地杀掉），而是**豁免被错误扩大**——严重度低于错杀但同属正确性缺陷。
- **修复建议**：复用引擎的同一判定，别维护第二套 `_cluster` 语义：

  ```ts
  import { extractClusterTarget } from "@/lib/run-utils";

  /** True when the node's params route execution to an SSH cluster … */
  export function isClusterRoutedNode(node: NodeDTO): boolean {
    return extractClusterTarget(
      (node.params as Record<string, unknown>)._cluster,
    ) !== null;
  }
  ```

### P1-2 RunsSheet 行容器的 `onKeyDown` 吞掉行内按钮的键盘激活：Stop/Retry 键盘不可达且触发误导航

- **文件**：`src/components/panels/runs-sheet.tsx:114-119`（`Row` 的 onKeyDown）、
  `422-440`（新增 Stop 按钮）、`464-481`（Retry 按钮）
- **问题**：`Row` 是 `div[role=button]`，`onKeyDown` 挂在行容器上且**不检查事件来源**。
  键盘用户 Tab 聚焦 Stop/Retry 后按 Enter/Space：keydown 从按钮冒泡到行容器 →
  `e.preventDefault()`（同时取消了按钮自身的默认 click 激活）→ 执行 `onClick?.()`（jumpTo：
  加载工作流 + 关闭 Sheet）。结果：**Stop 这个 E4 的安全关键操作无法用键盘完成**，
  且用户被带离当前视图。Retry 侧是 B4 时代的既有缺陷，本轮新增的 Stop 继承了它
  （审查重点 C 明确要求检查新按钮的键盘可达性）。
- **影响**：a11y + 键盘正确性；无法键盘中止运行中的节点。
- **修复建议**：

  ```tsx
  onKeyDown={(e) => {
    if (e.target !== e.currentTarget) return; // 行内按钮处理自己的键盘激活
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.();
    }
  }}
  ```

---

## P2（建议）

### P2-1 nodes POST 的 `params` / `x` / `y` 缺校验 —— 「不能当 blob store」的注释承诺不成立

- **文件**：`src/app/api/workflow/nodes/route.ts:66-69`（params）、`110-111`（x/y）、头注释 `13-14`
- 快照块对 `result/logs` 设了 1MiB 上限，但 **`params` 本身无上限**（任意大 JSON 直接
  `JSON.stringify` 入 SQLite）；`x/y` 只查 `typeof === "number"` —— JSON 里 `1e400` 会 parse 成
  `Infinity`、`NaN` 也通过，打到 Prisma 变 500。建议：
  ```ts
  const paramsJson = params && typeof params === "object" ? JSON.stringify(params) : "{}";
  if (paramsJson.length > 2 * 1024 * 1024)
    return NextResponse.json({ error: "params too large (max 2 MiB)" }, { status: 413 });
  const safeNum = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  ```
  （`params` 是既有面，非本轮引入；但 C3 的注释宣称封住了 blob 面，实际没封全。）

### P2-2 快照允许以 `pending` 复活 —— 产生无人认领的「永久排队」展示

- **文件**：`src/app/api/workflow/nodes/route.ts:85-88`
- `running` 被强转 `idle`，但 `pending` 原样入库。undo 恢复一个「当时在队列里」的节点 →
  DB 恒为 pending（runner 只在下一次整图 run / 单节点 run / 手动 Stop 时才会动它），
  `/api/runs` 会一直把它显示为 queued。建议与 running 一并转 idle（复活的节点背后没有
  live claimant，`pending` 的语义是「已被某次 run 认领」，复活节点不满足）：
  ```ts
  snapStatus = status === "running" || status === "pending" ? "idle" : status;
  ```
  （顺带记录既有缺口：`instrumentation.ts` 的 boot reconcile 只回收 `running`，不回收
  crashed run 留下的 pending 行——与 abort 后的 Stop 语义倒是互补。）

### P2-3 sweep-group-card 注释宣称「rAF-throttled transform」，实现未节流

- **文件**：`src/components/canvas/sweep-group-card.tsx:110-114`（注释）vs `138-156`（实现）
- 每次 pointermove 直写 `style.transform`（合成器层，性能实际可接受），也没有 node-card 的
  `setLiveDrag`。要么补 rAF 对齐契约，要么把注释改成「直写 transform（组卡边不跟随，见 E3
  简化）」。当前注释与实现漂移，下个读者会以为有节流。

### P2-4 组拖拽提交窗口与 3s mergeNodes 轮询的竞态：组卡可视觉回弹

- **文件**：`sweep-group-card.tsx:190-220`（upsert→PATCH 窗口）× `src/lib/store.ts:329-331`
  （mergeNodes 对非 dirty 节点 `{...cur, ...n}` 覆盖 x/y）× `src/app/page.tsx:233-255`（busy 时 3s 轮询）
- pointerup 后「N 次 upsert（新位置）→ PATCH 落库」之间若恰好命中一个 poll tick（同工作流
  有节点在跑时每 3s 一次），mergeNodes 会用**服务端旧 x/y** 覆盖 store → 组卡回弹到拖前位置；
  PATCH 成功后没有回写 upsert，且 busy 结束后轮询停止——store 与 DB 可能持续漂移到刷新。
  node-card 单卡拖拽同病（既有模式被忠实继承）。建议：拖拽提交时对成员 `markNodeDirty`
  （dirty 分支会保住 x/y，落库后自动解除），或 PATCH 成功后补一次 `upsertNode(服务器回行)`。

### P2-5 `stopAll`：过期 active 快照 + 非 OK 响应静默跳过 + toast 宣称「全部停止」

- **文件**：`src/components/panels/runs-sheet.tsx:322-360`
- `wfIds` 来自最多 3s 前的轮询数据（其间在其他工作流新起的运行不会被停）；循环里 `res.ok`
  为 false 的 workflow 级 abort 被静默跳过，最终 toast 仍说 "All active runs stopped"。
  建议：先 `fetch("/api/runs")` 取实时集再算 wfIds；收集失败项并在 toast 中如实呈现
  （"stopped N, failed to stop M"）。另注：`active = data?.active ?? []` 在 data 为 null 时
  每次渲染生成新数组 → `stopAll` 依赖 `[active, toast]` 身份不稳定（当前无重型下游，仅提示）。

### P2-6 Retry 的网络失败文案误导 + 注释漂移

- **文件**：`src/components/panels/runs-sheet.tsx:243-275`
- `fetch(...).catch(() => null)` 得到 `res=null` 时 toast 说 "…is retrying in the
  background" —— 实际上 POST 根本没发出去（网络失败），用户被误导以为在跑。
  建议 `res === null` 单独走 destructive toast（"Couldn't reach the server"）。
  另：注释 "clear on the next poll tick" 与实现不符（`setRetryingId(null)` 在 HTTP
  完成时才清，非 poll tick）。

### P2-7 ScreeningPanel 深链静默丢失

- **文件**：`src/components/panels/screening-panel.tsx:140-147`
- 列表加载失败（`screenings` 空但 `listLoading=false`）或 id 不在（可能过期的）列表里时，
  `pendingScreeningId` 被清空、无任何反馈——用户点了溯源徽标却什么都没发生。建议
  not-exists 分支 toast "Screening not found or deleted"。effect 本身（deps 完整、同步消费、
  等待 listLoading、无需清理）验证无问题。

### P2-8 history-apply 注释漂移：running→idle 强转重新引入 store/DB 状态漂移

- **文件**：`src/lib/history-apply.ts:197-204`（注释）vs `nodes/route.ts:87`（服务端强转）
- 旧注释明确告诫「a fresh row is always idle; the store keeps the snapshot's view until the
  next poll/reload reconciles it」，新注释改成 "the row mirrors the snapshot except for
  ids/timestamps" —— 对 status=running 的快照节点这**不成立**（DB=idle、store=running，
  直到下一次 reconcile）。建议恢复该告诫，或在 `finalNodes` 里同步把 running 改写为 idle
  （一处 map 内 `status: n.status === "running" ? "idle" : n.status`）。

### P2-9 `NodeDTO.params` 类型失真 + `ExecOutcome` 与 `NodeExecResult` 重复定义

- **文件**：`src/lib/types.ts:271`（`Record<string, string | number | boolean>`）×
  `src/lib/screening.ts:1754`（写入嵌套对象 `source`）；`src/lib/node-lifecycle.ts:31-35`
  vs `src/lib/workflow-engine.ts:23-27`
- C2 在 params 里写入嵌套 `source` 块：运行时正确，但类型声明撒谎（inspector/engine 全靠
  `as Record<string, unknown>` 绕过，包括新的 `promoteSource` 解析——它是防御式的，但防御
  的对象本不该需要防御）。建议 `params: Record<string, unknown>` + 专用解析器。另：
  `ExecOutcome` 与引擎的 `NodeExecResult` 结构完全相同，两处维护同一契约易漂移，建议
  node-lifecycle 复用/重导出 `NodeExecResult`。

### P2-10 abort 不会加速看门狗：Stop 之后挂起的引擎仍占用 pool lane 直到超时上限

- **文件**：`src/lib/node-lifecycle.ts:143-153`（abort 路由注释 "the runner's finally
  unlocks downstream and the pool moves on"）× `workflow-runner.ts:240-255`（finally 要等
  runNode settle）
- JS 无法取消 executeNode，abort 只改 DB 状态；runner 的 `finally`（解锁下游 + 归还 lane）
  要等引擎 promise settle 或看门狗到点（最长 15/150min）。语义正确且有界（非 bug），但
  abort 路由的注释**过度承诺**「pool moves on」——实际是「等引擎自然结束或看门狗兜底」，
  下游解锁同样被推迟。可选改进：`executeWithWatchdog` 再 race 一个 abort 探测 promise
  （如每秒查 `db.node` status≠running → 提前 resolve timedOut 语义），或至少把注释改准确。

### P2-11 轻量杂项（不改也不阻塞验收）

- `runs/abort/route.ts:28` `if (!nodeId === !workflowId)`：逻辑正确（XOR）但可读性差，建议
  `(nodeId ? 1 : 0) + (workflowId ? 1 : 0) !== 1`。
- `runs/abort/route.ts:48`：409 消息里的 `node.status` 来自 abort 前的 findUnique，窄窗口内
  可能过期（仅文案准确性）。
- `node-lifecycle.ts:93` `markWatchdogTimeout` 的 `minutes = max(1, round(ms/60000))`：
  e2e 用 `NODE_TIMEOUT_MS=50` 时消息会说 "~1 min"（仅测试路径文案不准）。
- `sweep-dialog.tsx:485-489` C5 文案把「不等 source 输出」只挂在「无上游」分支；实际任何
  情况下变体都不等 source 本身（有上游时等的是 source 的上游）——表述有歧义。
- `node-group.tsx:155` 组标签计数 `gb.nodeIds.length` 含被折叠隐藏的成员，而包围盒只算
  可见成员（标签说 4、框住 2）——纯展示不一致。
- `NODE_TIMEOUT_MS` 覆盖用途未写进 `docs/CONTRIBUTING.md`（E1 的 e2e 旋钮，值得一行文档）。

---

## 已验证无问题（推演确认正确的设计点）

1. **persistExecOutcome 的条件写回契约（本轮核心）**：所有 outcome 写回都带
   `where status="running"`；abort（`where status in [running, pending]`）与看门狗
   （`where status="running"`）先落者赢，晚到的引擎结果 count=0 被丢弃——runner 与单节点
   route 两条 lane 均无「复活」窗口（唯一例外见 P0-1 的 SSE lane）。poll-ceiling 的
   `status:"running"` 分支同样条件化且不写 completedAt/progress-100，语义与改造前一致。
2. **看门狗不会楔死 worker pool**：`executeWithWatchdog` 必然 settle（超时兜底）→
   `runNode` return → `finally` 归还 `inFlight` + 解锁下游 → `pump/settle`（queue 空 &&
   inFlight=0 才 resolve）。晚到的引擎 rejection 也被 `Promise.race` 内部 handler 消化，
   **不会产生 unhandledRejection**；`exec()` 同步 throw 被 try/finally 正确清 timer。
3. **abort pending 节点 → runner claim（pending/idle→running）count=0 → skip**：
   无幽灵执行；`finally` 对 claim-lost 节点也解锁下游——这是既有的、注释明示的语义
   （"claim lost" 与「失败不剪枝」一致），本轮无回归。BFS 级联对 failed 节点不再入选，
   循环可正常终止。
4. **单节点 route 的 reclaimer 与 abort 交互**：双重执行防护完好（claim/reclaimer 均为
   原子 updateMany，并发 POST 第二个拿 count=0 → 409）；abort 落在 failed→running
   窗口内时拿到诚实的 409（当时确无 running/pending 行）。abort 后晚到的 persist 被
   条件写回丢弃，且 runOne 以 "failed" 返回、级联不再向下游蔓延。
5. **组卡拖拽契约**：zoom 换算与 node-card 完全一致（screen delta / zoom = world delta，
   提交时 Math.round）；pointerdown 排除交互后代（B3 pointer-capture 教训被正确吸收，
   Compare/Expand 按钮 click 不受影响）；点击（<4px）仍展开；`releasePointerCapture` 带
   try/catch；历史快照 push 时机正确（**改动前**一次快照、upsertNode 不可变更新使快照引用
   保持有效、canvas 订阅只捕获计数变化故无双推）；PATCH 只送 x/y；失败回滚 + toast。
   拖拽期间成员状态变化的窄窗口（渲染闭包过期）会被 3s 轮询自愈（P2-4 是唯一例外场景）。
6. **node-search / node-group 折叠过滤**：`deriveSweepGroups` 的 groupId 与
   `collapsedSweepGroups` 同源（`node.sweepGroup`）；node-group memo 依赖完整
   （[groups, nodes, collapsedMemberIds]），全折叠组跳过、部分折叠重算包围盒；
   node-search 的 effect 依赖含 collapsedSweepGroups。开销 O(n) 量级、频率低，无性能问题
   （canvas 侧的 sweepGroups 也有 useMemo）。
7. **nodes POST 快照验证**：status 枚举校验（未知值安全降级 idle）、running→idle 强制、
   progress clamp 0-100、result/logs 1MiB 上限真实生效（>上限→null/""）、terminal 才写
   startedAt/completedAt。history-apply 传参字段对齐，round-trip 正确。
8. **promoteSource 防御式解析**：kind/screeningId 双重校验、candidates 数组元素逐个
   typeof 守卫，malformed JSON / 旧节点一律退化为 null（徽标不渲染），不会 break Inspector；
   徽标是原生 button（键盘可达），`data-provenance-badge` 供 e2e 定位。
9. **Retry fire-and-forget 无 unhandled rejection**：IIFE 内 fetch 带 `.catch(()=>null)`、
   `res.json()` 带 catch、toast 不抛；`stop`/`stopAll` 的 IIFE 均 try/catch/finally 全包。
10. **SQL 注入面**：全部走 Prisma 参数化查询，无字符串拼接；`sweepGroup` trim+slice(64)。
11. **runs-sheet 3s 轮询无回归**：poll effect（[open] 依赖、alive 守卫、关闭清理）未动。

## 工具链验证（2026-10-08 实测）

- `cd /home/z/my-project && bunx tsc --noEmit 2>&1 | grep -v "^examples/\|^skills/"`
  → **输出为空（src/ 零错误）**。原始 tsc exit=1，4 条报错全部位于
  `examples/websocket/*`（socket.io 模块声明缺失）与 `skills/*`——均为仓库预存、
  按 CONTRIBUTING 约定排除，与本轮改动无关。
- `bun run lint`（`eslint .`）→ **exit 0，零告警**。
- 审查未修改任何代码，工作区保持 Task 22 交付原样。

## 建议的修复顺序

1. P0-1（一行条件写回，SSE lane 接入契约）→ 顺手做 P2-2（pending→idle 一行）。
2. P1-1（isClusterRoutedNode 复用 extractClusterTarget）——影响 E1 有效性判定。
3. P1-2（Row onKeyDown 来源守卫）——E4 键盘可达性。
4. 其余 P2 按迭代节奏消化；P2-4/P2-5/P2-6 建议随下一次 RunsSheet/拖拽相关改动带上。
