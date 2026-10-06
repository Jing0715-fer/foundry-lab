# QA 深度代码审查报告 — B 线（画布与执行引擎）四改动

- **Task ID**: 19-a
- **审查范围**: B1 布局防重叠 / B2 并行执行通道 / B3 Sweep 聚合组卡 / B4 Runs 视图（git 未提交改动 + 3 个新文件）
- **审查方式**: 逐文件人工静态审查（含 git diff 对照、runner 不变量证明、并发语义推演、React 生命周期推演），复跑 `tsc --noEmit`（src/ 零错误，报错仅存在于 examples/ 与 skills/，非本轮改动）
- **结论**: **无 P0 阻断项**。并行执行引擎的核心正确性（无死锁、无双执行、异常不楔死）论证成立。发现 4 项 P1 应修、12 项 P2 建议。

---

## P1 — 应修（4 项）

### P1-1 sweep 防避让被无条件 4000 截断撤销，可自叠回源节点
- **文件:行号**: `src/app/api/workflow/nodes/[id]/sweep/route.ts:229`
- **问题**: `anchorY = Math.min(anchorY, 4000)` 在步进循环**之后无条件**执行。两条失效路径：
  1. **自由位被拉回重叠区**：循环正常退出（blockHits=false 找到空位）但空位 y > 4000 时，截断把整块网格拉回 4000 —— 该位置从未做过 blockHits 校验，可能落在源节点或第一轮 sweep 网格上。具体复现：源节点拖到 y=3900（WORLD_MAX=5000 内合法）→ 初锚 y=4110 下方为空 → 循环零步退出 → 截断到 4000 → 网格 [4000,4420] 与源卡 [3900,4016] 垂直重叠 16px。源 y 越大重叠越深。
  2. **200 步上限路径同样先截断再落位**，落在 4000 的重叠是"设计上接受"，但与路径 1 无法区分。
- **附带**: 24 组合 sweep（8 行）锚定 4000 时底边 = 4000+1680 = **5680 > WORLD_MAX(5000)**，"keep inside the world viewport" 注释与现实不符（`workflow-catalog.ts:9` WORLD_MAX=5000）。
- **影响**: B1-sweep 的核心目标（防叠卡）在深画布/大 sweep 场景被静默击穿；变体可能落在世界边界外。
- **修复建议**: 把上界纳入搜索本身而非事后截断——
  ```ts
  const maxY = WORLD_MAX - gridH;            // 用真实世界界而非魔数 4000
  for (let stride = 0; stride < 200 && (anchorY > maxY || blockHits(anchorX, anchorY)); stride++) {
    anchorY += gridH + EXISTING_GAP * 2;
  }
  if (anchorY > maxY) anchorY = maxY;        // 仅在真正无解时接受上限位重叠
  ```
  （`WORLD_MAX` 需从 workflow-catalog 导入；stride 上限保留兜底语义。）

### P1-2 /api/runs 全量拉取 result/logs 大字段后才裁剪，与注释声明相反，且被 3s 轮询放大
- **文件:行号**: `src/app/api/runs/route.ts:27-42`（查询）+ `44-55`（trim）
- **问题**: 文件头注释（13-14 行）声称 *"Node rows are trimmed to the fields the runs sheet renders (never result/logs bodies — those can be huge)"*，但 `db.node.findMany` **未用 `select`**，默认取回全部标量列——包括 `result` 与 `logs` TEXT 大字段（LLM 多轮 result、ranking_debug JSON、工具日志），trim 只发生在 JS 内存里。terminalRows `take: 80`、activeRows 无上限，RunsSheet 打开期间每 3s 全量取一次。
- **影响**: 每次 3s 轮询反序列化 80+ 行 × 可能数十 KB 的大字符串；SQLite 本地读放大 + 响应组装开销；注释与实现不一致会误导后续维护者。
- **修复建议**: 查询级 `select`（Prisma 支持与 include 等价的嵌套 select）：
  ```ts
  const RUN_FIELDS = {
    select: {
      id: true, name: true, type: true, status: true, progress: true,
      startedAt: true, completedAt: true,
      workflow: { select: { id: true, name: true } },
    },
  } as const;
  // activeRows / terminalRows 均传 RUN_FIELDS
  ```
  顺带给 `activeRows` 加 `take`（如 200）做防御性上限。

### P1-3 RunsSheet 失败行 Retry 按钮嵌套在 Row 的 `<button>` 内（button-in-button）
- **文件:行号**: `src/components/panels/runs-sheet.tsx:100-104`（Row 根元素 `<button>`）+ `304-320`（trailing 传入的 shadcn `<Button>`）
- **问题**: `Row` 渲染 `<button type="button">…{trailing}</button>`，失败行 trailing 是真 `<button>Retry</button>` —— 交互元素嵌套交互元素，HTML 规范非法（`<button>` content model 不允许 interactive content）。`e.stopPropagation()` 救得了点击语义，救不了 DOM 有效性：屏幕阅读器对嵌套按钮的播报行为未定义，键盘焦点顺序在两个"按钮"间摇摆；Radix Sheet 关闭时 SSR/hydration 无碍（关闭态不渲染），但这是随失败行必然出现的常态结构。
- **影响**: a11y 违规 + 无效 HTML；lighthouse/a11y 审计必挂项。
- **修复建议**: Row 根改为 `<div role="button" tabIndex={0} onKeyDown={…}>`（参考 sweep-group-card.tsx 的做法），或把 trailing 操作区做 Row 的**兄弟**节点（flex 行容器内 `Row主体 + RetryButton` 平级）。

### P1-4 框选（rubber-band）用全量 `workflow.nodes` 原坐标命中测试，可选中已折叠隐藏成员并对其批量删除
- **文件:行号**: `src/components/canvas/workflow-canvas.tsx:502-512`（`onPointerUp` 的 hitIds 计算）
- **问题**: 框选命中测试遍历 `workflow?.nodes` —— 折叠组隐藏成员仍在其中，且用的是**原始坐标**（B3 渲染用的是 `layoutNodes` 映射坐标）。框住折叠组卡所在区域（= 成员网格原点区域）会把所有不可见成员选入 `selectedIds`，浮出多选操作条（Delete/Group），用户在**看不见任何被删对象**的情况下可执行批量删除。
- **影响**: 破坏 B3 折叠语义的完整性：对不可见卡片做破坏性操作；与 EdgesLayer/LiveWire 已用 `layoutNodes` 的做法不一致。
- **修复建议**: hitIds 过滤改用 `visibleNodes`（或 `layoutNodes` + `collapsedMemberIds` 排除）：
  ```ts
  const hitIds = visibleNodes.filter((n) => { /* 原有 AABB 测试 */ }).map((n) => n.id);
  ```
  （可顺带在 `select(id)`/`inspect(id)` 入口检测命中隐藏成员时自动展开该组，见 P2-8。）

---

## P2 — 建议（12 项）

### P2-1 `isTerminal` 死代码
- `src/lib/workflow-runner.ts:130-131`：定义后从未使用（blockers 判断直接写了 `pending || idle`）。删除，或真正用于 isTerminal 判定以表达意图。

### P2-2 peakConcurrency / started 在竞态下虚报
- `src/lib/workflow-runner.ts:222-225` + `101`：claim 失败的空车道同样计入 `inFlight`/`peakConcurrency` —— 双击 Run 挤过 409 预检的第二个 lane 会报 peakConcurrency=3、started=N 而 completed=0。仅遥测口径问题（toast/运维误导），不影响执行正确性。建议 claim 成功后再 `peakConcurrency = max(...)`。

### P2-3 每节点全量重取 workflow（N+1 式）+ `queue.shift()` O(n²)
- `src/lib/workflow-runner.ts:157-183`（freshWf 全量 include）与 `223`（shift）。当前规模（≤ 百节点）无碍；freshWf 是为并行兄弟写入的最新快照，属有意设计，仅建议：>200 节点时改为按节点查上游行 + 用索引代替 shift（或双栈/指针）。

### P2-4 无看门狗：executeNode 挂死会楔死整个 pool 与宿主请求
- `src/lib/workflow-runner.ts:185-189`：executeNode 无超时（workflow-engine 内部 catch 只兜异常不兜挂起）。一个挂起的引擎调用 → inFlight 永不归零 → `runWorkflowById` 永不 resolve → run route 的 POST 永久挂起、scheduler 该 lane 卡死（其余 lane 不受影响）。**顺序版同样存在此风险，非本轮回归**；但并行版把 3 个节点同时暴露在单点挂起下。建议对 executeNode 加 per-node 超时（如 30min）标 failed。

### P2-5 dropAvoiding 事后 clamp 可撤销避让；palette/command-palette 无世界边界钳制（行为不对称）
- `src/lib/canvas-utils.ts:262-275`：`findFreeSpot` 螺旋候选可越过 WORLD 边界，最终 clamp 拉回后可能重新落回原重叠点（右缘投放场景）。另外 `palette.tsx:96`、`command-palette.tsx:74` 用裸 `findFreeSpot`（**无**边界钳制，视口平移到远处时中心世界坐标可超界建节点），而 canvas 三个入口用 `dropAvoiding`。B1 的"共享"目标实际固化了两种行为。建议统一走 `dropAvoiding`，并把 clamp 移进螺旋候选生成（候选生成时即 clamp 再测重叠）。

### P2-6 minimap 折叠不一致：边仍画向隐藏成员原坐标；锚点取数组序首个成员
- `src/components/canvas/canvas-minimap.tsx:199-217`：边渲染用 `nodes.find`（全量原坐标），成员点已隐藏 → 折叠时 minimap 出现指向空位的悬空连线（主画布 EdgesLayer 已映射到组卡坐标，两者不一致）。`64-79` 的锚点取 `nodes` 数组序第一个成员——undo/redo id 重映射后数组序未必等于创建序，锚点可能落在组包围盒中下部而主画布组卡在左上角。建议：边几何复用 mmNodes/映射坐标；锚点显式取 `Math.min(x), Math.min(y)`（与 deriveSweepGroups 对齐）。

### P2-7 组卡 div[role=button] 内含两个可聚焦按钮（ARIA 嵌套交互）
- `src/components/canvas/sweep-group-card.tsx:93-110`（role=button 根）+ `165-203`（Compare/Expand 真 button）。HTML 合法（div 可含 button），但 ARIA 指南：button role 不应包含可聚焦后代。现有键盘路径可用（Tab 分别可达、Enter/Space 展开卡片）。低危，建议根改 `role="group"` + 把"展开"绑定到专用区域/按钮（Expand 按钮已存在，卡片主体的 onClick 保留即可）。

### P2-8 折叠后 selectedId/inspectId 指向隐藏成员：功能可用但可视反馈缺失
- 折叠时 `toggleSweepCollapse` 不清选择（`store.ts:403-409`）；inspector 仍能编辑隐藏成员（node 仍在 store/DB，PATCH 正常）—— 无崩溃无脏数据，但用户在画布上看不到正在编辑的卡。建议：`select/inspect` 目标 ∈ collapsedMemberIds 时自动展开该组（体验闭环），或折叠时清选择。

### P2-9 NodeSearch / NodeGroupLayer 仍索引全量节点
- `node-search.tsx:25`、`node-group.tsx:70-72`：折叠成员仍出现在搜索结果（点击选中一个看不见的节点）；语义组 overlay 仍按隐藏成员原坐标绘制包围盒。建议搜索结果过滤 `collapsedMemberIds`，组 overlay 同理。

### P2-10 `completedInWindow` 统计被 80 行 overfetch 截断
- `src/app/api/runs/route.ts:72`：`terminalRows.filter(completed).length` 只数 `take: 80` 取回的行 —— 48h 内终态节点 > 80 时该数静默封顶，sheet 摘要行（runs-sheet.tsx:263）显示偏低。建议单独 `db.node.count({ where: { status: "completed", startedAt: { gte: since } } })`。

### P2-11 Retry 语义：按钮自旋数分钟、"Retry started" 实际在完成后才弹
- `src/components/panels/runs-sheet.tsx:213-242`：`POST /api/workflow/nodes/:id/run` 会 await 完整执行 + BFS 级联 —— Retry 按钮的 Loader 状态持续整个引擎时长（工具节点可达分钟级），toast "Retry started" 在执行结束后才出现（描述与时机矛盾）；长工具下浏览器/代理可能断连。属沿用的单节点 lane 既有设计，非本轮回归。建议改为 fire + 依赖 3s 轮询展示状态（代码里已有轮询）。顺带：162-185 轮询无序号守卫，慢响应可能乱序覆盖新数据（`void load()` 可重叠）——加一个请求序号即可。

### P2-12 持续轮询失败被渲染成"空队列"
- `src/components/panels/runs-sheet.tsx:171-176`：catch 静默保留旧 payload（防 toast 风暴，合理），但**首次加载即失败**时 data=null、loading=false → 三个 section 显示"Nothing executing / No failures / No finished"，与服务端故障无从区分。建议 data===null 且连续失败 N 次时显示错误态 + 重试按钮。

### 其他零星（不单列）
- `src/app/api/workflow/run/route.ts:1-2`：注释仍写 "run a workflow in topological order"，已改并行 —— 文档漂移。
- 组卡不可拖拽（折叠态移动需先展开）—— UX 取舍，建议后续支持整组拖动。
- 头部注释 `workflow-runner.ts:24` 返回值描述漏了 peakConcurrency —— 顺带补。
- git 工作区含 `db/custom.db`（二进制变更）与 `.zscripts/dev.pid` —— 提交前应剔除（dev 产物）。
- header 新增 Runs 图标按钮后，375px 已紧凑（工作流切换器 hidden、Run 文字 hidden 兜底），**320px 档建议复测**。

---

## 已检查无问题的区域（明确结论）

### A. workflow-runner.ts 并行正确性（最高优先 —— 通过）
1. **pump/settle 无死锁**：每个任务完成路径必经 `finally` → `inFlight--` → `pump()`（同步补位新任务）→ `settle()`；resolve 仅在 `queue.length===0 && inFlight===0` 时触发。queue 非空且 inFlight=MAX 时，任一 in-flight 结束都会重触发 pump——链条无断点。`resolve` 幂等，重复调用无害。runNode 为 async（首个 await 前不返回），不存在同步完成绕过 finally 的路径。
2. **不变量证明（初始 blockers vs unlock 减计数一致）**：对每个 runnable 节点 B，初始 `indeg[B] = 源快照中 pending/idle 上游数`；运行期内对边 (U→B) 的减计数事件**当且仅当 U 是 pending/idle 快照态**（runnable → 由归纳必被入队 → 恰好触发一次 finally；completed/failed 上游非 runnable → 永不入队 → finally 永不触发 → 永不减）。两边集合精确相等，重边（A→B 两条）也对称（blockers 计 2、adj 减 2，第二次减才到 0 只 push 一次）。**任务提示的"completed/failed 上游的边也被减 → 提前归零"不成立**——这些上游根本不会产生减计数事件；"入队后 claim 失败无害"论证成立（skip + 本地解锁，与顺序版 continue 语义一致）。
3. **无双入队/无双执行**：入队仅两处（初始 blockers===0；递减到 0 且 runnable），indeg 严格单调递减且初始 push 的节点 indeg 已为 0，二次 push 需从 1 减到 0 而值只能 ≤0 → 不可能。每节点至多 runNode 一次。
4. **异常路径**：executeNode 全量内部 catch（`workflow-engine.ts:606-611` 返回 failed 而非抛出），runNode 实际只可能因 DB 操作抛异常 → pool catch 标 failed（fire-and-forget best-effort，.catch(() => {}) 防未处理 rejection）→ finally 保证 `inFlight--` + 下游解锁 + pump/settle 重触发 —— **无楔死路径**。
5. **与单节点 run route 的并发**：双方均为条件 `updateMany` 原子 claim；Prisma SQLite 单连接串行化写 → 无双赢；runner 输单 → 静默 skip + 解锁；单节点 lane 输单 → 409（running 态）/ 终态重 claim（`run/route.ts:55-63`）。双输不存在。409 预检（run route 42-55）+ 按钮 disabled 双保险。
6. **scheduler.ts 接口兼容**：只用 `ok/started/completed/error`（`scheduler.ts:81-107`），`peakConcurrency` 为纯新增字段，向后兼容。scheduler 顺序 await 各 schedule，多 schedule 同 workflow 并发时由 claim 仲裁。
7. **引擎并行安全**：workflow-engine 模块级仅两个不可变 Set；gatherInputs 纯函数；每节点输出目录独立（wf-<ts>-<rand>）；3 并发 LLM/子进程调用无共享可变状态。

### B. sweep 避让边界（通过，除 P1-1）
- **GAP 每边只加一次**（block 右缘 +GAP、左缘 −GAP，节点侧不加）→ 有效间距 60px，非 120px；步进 stride 的 `GAP*2` 只是步幅，逐位置重测，无跳过空档的正确性问题。
- gridW=900 ≥ 实际最右列 2*300+248=848（保守过估）；gridH 按整行计，末行不满时同样保守。初锚 y=源+210 距源卡 210-116=94 > 60 → 首次 sweep 不与源自撞（实测 y=310/640 一致）。
- **undo 重放不受避让影响**：`POST /api/workflow/nodes`（route.ts:49-71）原样写 x/y、sweepGroup 仅 trim+截断 —— 重放确定性保组。

### C. B3 渲染（通过，除 P1-4/P2-6/7/8/9）
- **useMemo 依赖正确**：`sweepGroups=[nodes]`、`collapsedGroups=[sweepGroups, collapsedSweepGroups]`、`collapsedMemberIds=[collapsedGroups]`、`visibleNodes=[nodes, collapsedMemberIds]`、`layoutNodes=[nodes, collapsedGroups]` —— nodes 引用变化（含 undo/redo 重建）全部重算。`workflow?.nodes ?? []` 在 workflow 为 null 时每渲染新数组，仅空态微量重算，无害。
- **边位置映射正确**：EdgesLayer/LiveWire 均改喂 `layoutNodes`（成员坐标 → 组卡 x,y），视觉接线到聚合卡。NodeCard 自身读 node.x/y 定位，隐藏成员不渲染，无冲突。
- **history 捕获不受折叠影响**：折叠是纯 UI 状态（collapsedSweepGroups 不触碰 workflow），订阅（workflow-canvas.tsx:327-364）无事件；undo/redo 的 setWorkflow 会重派生组；折叠态存留的 stale groupId 无害（派生为空）。
- minimap `mmNodes` 的 hidden/anchors 逻辑功能正确（anchor 同时进 hidden 与 anchors，经 `visible + anchors` 恰好出现一次）；`contentBox(mmNodes)` 与点渲染均用 mmNodes。

### D. runs route + runs-sheet（通过，除 P1-2/P1-3/P2-10/11/12）
- **N+1**：`include: { workflow: { select } }` 为 JOIN，非 N+1。类型：`(typeof activeRows)[number]` 与 terminalRows 结构同型，tsc 通过。
- **轮询生命周期**：`alive` flag + `clearInterval` + `if (alive)` 守卫 —— 无 unmount 后 setState（RunsSheet 常驻 page.tsx，Radix 关闭只卸载内容不卸组件）；关闭即停轮询。
- **jumpTo 无撤销串图回归**：`store.setWorkflow`（store.ts:179-187）检测 id 变化清空历史栈；画布订阅（workflow-canvas.tsx:339）忽略 `prevWf.id !== curWf.id` 的转换 —— 跨工作流跳转后 Ctrl+Z 无操作，与 Task 12 修复语义一致。同工作流跳转不清栈（正确）。
- **Retry 依赖的单节点重跑 claim 语义**已核实（terminal 条件重 claim + 级联条件 claim）。

### E. 通用
- **TypeScript**：src/ 零错误（本轮复跑确认；报错仅 examples/websocket、skills/* —— 预先存在，非 src）。
- **未处理 Promise**：新增代码全部 `void fn().catch()` 或 try/catch（runner pool 的 catch/finally 链、runs-sheet 的 void load/jumpTo/retry）—— 无裸浮 Promise。
- **console 遗留**：B 线新增文件零 console.*（scheduler 的既有日志非本轮）。
- **a11y**：Runs 头部按钮 aria-label ✓、组卡 role/aria-label/tabIndex/Enter+Space ✓、progressbar role + aria 值域 ✓、node-card sweep 徽标变 button（键盘可达、stopPropagation 防误选）✓；例外见 P1-3 / P2-7。
- **移动端**：RunsSheet `w-full sm:max-w-md` ✓、组卡 248px 与节点卡一致 ✓；header 收紧见"其他零星"。

---

## 修复优先级建议
1. P1-2（runs 查询 select 化）—— 一行改动、消除每 3s 的读放大，先修。
2. P1-4（框选用 visibleNodes）—— 防不可见破坏性操作。
3. P1-3（嵌套按钮）—— 结构修复防 a11y 债。
4. P1-1（sweep clamp 语义）—— 深画布场景罕见但违背功能目标，随下一批修。
5. P2 项按顺手原则打包（isTerminal 删除、completedInWindow count、注释漂移零成本）。

*本报告仅审查，未修改任何代码。*
