# QA 深度审查报告 — F 线 P1 七项交付（Task 30-a）

- 审查人：qa-code-reviewer（纯审查，零源码修改）
- 范围：`git status` 全部未提交改动（24 个修改文件 + 3 个新文件，+574/−168），逐 diff 过读；新文件全文通读；交叉回归 grep；工具链复跑。
- 基线不变量（承自 worklog）：执行通道写点条件化 `where status="running"`；Stop 落定不可复活；卡内 button 真实指针实测；多工作流契约（`/api/workflow` 恒返回最早工作流）。
- 工具链：`bunx tsc --noEmit` → 仅 4 条预存错误（全部在 examples/ + skills/，src/ 零错误，与审查前一致）；`bun run lint` → 零告警。Prisma client 已含 `Workflow.groups`，`db/custom.db` 实测可查（探针 OK）。

---

## P0（0 条）

无。四个核心不变量均未被本轮改动破坏：stop route 新增写点不触碰节点翻转语义（见 P1-4 之外的验证）；无执行通道新增无条件下写；多工作流契约方向全部正确（F2/F6 各取数点按 id）；无复活 Stop 落点的新 lane。

---

## P1（4 条）

### P1-1【F5】折叠组 liveDrag 的边锚点空间错位 —— 组拖拽首帧边"飞向"不可见的散点成员位置

- 文件：
  - `src/components/canvas/edge-drag-patch.ts:59-63`（`patchEdgeGroups` 用 `workflow.nodes` **原始**成员坐标计算几何）
  - `src/components/canvas/sweep-group-card.tsx:161, 169-197`（组拖拽 live patch）
  - `src/components/canvas/workflow-canvas.tsx:721-731, 775`（`layoutNodes` 把折叠成员映射到聚合卡左上角 `(g.x, g.y)`，`EdgesLayer` 以 layoutNodes 渲染）
- 机理：折叠时 `EdgesLayer` 收到的节点数组把每个成员位置改写为聚合角（`deriveSweepGroups` 的 `Math.min` 包围盒左上角）。而拖拽期间的 live patch 用 **store 原始成员坐标 + (dx,dy)** 重算几何。首帧 patch 起，每条挂在成员上的边端点瞬间平移 `(x_i − g.x, y_i − g.y)`（成员在包围盒内的偏移；典型 sweep 纵排 y=0/220/440/660 → 最大 ~440 世界像素），随后整段拖拽期间边跟踪的是**不可见**的散点成员位置；松手 `mergeNodes` 落位后 layoutNodes 重新锚到新包围盒角，边再跳一次。`g = (min x, min y)` 甚至可能不是任何真实成员的占位。F5 的目标"边实时跟随聚合卡"未达成，且比改动前"冻结在旧锚点"的观感更差（两次可见跳变）。
- 影响面：所有折叠组拖拽（≥2 成员即触发，仅恰在 min 角的成员例外）。单卡拖拽不受影响（可见节点的 raw 坐标 == layout 坐标）。
- 修复建议：给 `patchEdgeGroups` 增加可选 `nodesOverride`（或 anchor 映射），`sweep-group-card` 传入把成员改写到 `(g.x, g.y)` 的 layout 等价数组（镜像 `layoutNodes` 语义）；node-card 继续传 raw（天然一致）。顺手把 `:63-68` 的 `workflow.edges.find`（每帧 O(E²)）换成入参 Map。

### P1-2【F6】组持久化防抖窗口内切换工作流 → 跨工作流污染 + 双侧组数据丢失

- 文件：`src/components/canvas/node-group.tsx:27-59`（`scheduleGroupPersist` 在**触发时**读 `useAppStore.getState().workflow`）+ `:126-143`（hydrate effect 的 `persistPending` 抑制）。
- 机理：组编辑后 600ms 防抖才发 PATCH，payload/目标 workflowId/剪枝基准全部在**触发时**解析。若用户在窗口内切换工作流（A→B）：PATCH 打到 **B**，payload 是 A 的组、nodeIds 对 B 的节点剪枝（cuid 不相交 → 几乎必为 `[]`）→ **B 的已存组被清空，A 的新组从未落盘**；同时 `persistPending` 抑制让 B 的真实组不 hydrate（渲染层按 live 成员过滤，A 的组对 B 不可见 —— 表面无症状，污染已发生）。与 Task 12 修复的"跨工作流撤销污染"同族。
- 伴随缺陷：`.finally(() => { persistPending = false })`（`:55-57`）无条件清标志 —— 若 in-flight PATCH 期间又发生新的组编辑（`scheduleGroupPersist` 在 t1 置 true），旧 PATCH 的 finally 在 t2<t1+600 把标志清掉 → 第二次编辑仍在防抖中，hydrate 已不设防 → 一次 refetch 用服务端 v1 覆盖本地 v2，**第二次编辑丢失**。
- 修复建议：schedule 时捕获 workflowId，触发时 id 不一致则丢弃（或立即对捕获 id 冲刷）；finally 改为"仅当无新 timer 时清标志"（计数或 `persistTimer !== null` 判断）；切换工作流时主动 flush 或清空组 store。

### P1-3【F7】rowUpdatedAt 仲裁只接线了一半 —— setNodeStatus 从不把水位写进节点 DTO，守卫在其目标场景失灵

- 文件：
  - `src/lib/store.ts:290-329`（`setNodeStatus` 只写 status/progress/result/logs/completedAt/startedAt，**不写 updatedAt**）
  - `src/lib/store.ts:217-227`（`upsertNode` 守卫比较 `n.updatedAt <= existing.updatedAt`）
  - `src/app/api/workflow/nodes/[id]/stream/route.ts:205-211`（settled 分支 `rowUpdatedAt: new Date()`）
- 机理：守卫的仲裁基准是 store 里 `existing.updatedAt`，但主要终态通道（SSE status → setNodeStatus）从不刷新该字段。SSE 落定 failed/completed 后，`existing.updatedAt` 仍是上一次 upsert/merge 写入的旧值（常见为建节点时间）。晚到的 run POST 响应携带 running 快照（行读于 run 起写之后 → `n.updatedAt` = 起跑时间 > 旧水位）→ `<=` 判 false → **守卫放行，running 快照复活终态**——正是 #6 要拦的场景。ROADMAP #6 明确"轮询因 busy=false 停止不再自愈"，mergeNodes 也只有在 3s 轮询恰好落在 run 起写之后才会带来新水位（长任务概率性有效，快节点必失守）。
- 误杀面已核实为零（守卫条件精确收敛）：NodeStatus 仅有 idle/pending/running/completed/failed，排除集 {completed, failed, pending, idle} 后守卫只会拒 running 晚包 —— Retry(pending) 恒放行、Stop/watchdog 写终态不触发、undo/redo 走 `history-apply.ts:300` 的 setWorkflow（绕过守卫）、C3 恢复 completed DTO 为终态跳过、删除后 Ctrl+Z 时 existing 不存在跳过。
- 修复建议：`setNodeStatus` 写入 `updatedAt: rowUpdatedAt ?? n.updatedAt`（把水位落进 DTO）；settled 分支改用行真实写时间（updateMany 后重读，或记录写入用的 Date）而非 `new Date()`；可选：inspector 在 done 事件后 upsert 服务端行以落终态行时间。

### P1-4【F6/运维】demo 基线库缺 `Workflow.groups` 列 —— `bun run demo:reset` 之后全站 workflow 查询 500

- 文件：`prisma/schema.prisma:155`（新列）；`scripts/reset-demo.ts:64`（`copyFileSync(BASELINE, LIVE)` 原样覆盖）；`db/demo-baseline.db`（实测探针报 `The column main.Workflow.groups does not exist`）。
- 机理：本轮 `prisma db push` 只作用于 `db/custom.db`（实测可查 groups），基线快照早于 schema 变更。`demo:reset` 是裸文件复制 → 复制出的 custom.db 缺列，而再生成的 Prisma client 会 SELECT 该列 → 每次 workflow 读全部抛 "column does not exist"（/api/workflow、/api/workflows/* 全 500），直到人工再跑 db push。与 ROADMAP C4 stale-client 同族的"schema 漂移"陷阱，且 reset 是 README/CONTRIBUTING 记载的标准流程。
- 修复建议：演示数据核验后 `bun run demo:snapshot` 重冻基线；或 reset 脚本在复制后执行 `prisma db push`；更稳妥的是 reset 前 `PRAGMA table_info(Workflow)` 做列指纹校验，不匹配即报错并提示。**此条必须在提交前落地**（与既有"db 变更与配套文件同 commit"的提交纪律一致）。

---

## P2（5 条）

### P2-1【F3】stop route 的 stderr 标记与集群 sweep 的读改写竞态（标记可能被清 / 行被翻回 running）

- 文件：`src/app/api/workflow/nodes/[id]/stop/route.ts:53-66`（集群 lane：findUnique→update 追加标记）、`:72-92`（本地 lane 同型 TOCTOU，预存形状）；`src/lib/cluster/cluster-run.ts:830-837`（sweep ALIVE 分支整写 `status:"running"` + stderr）、`:784-792, :808-816`（EXIT≠0/vanished 分支整写 failed + stderr）。
- 机理：sweep 的远端读取与行写入之间隔着整段 SSH 批处理（timeout 25s）。用户 Stop 落在两者之间时：sweep 的 `applySweepBlock` 不复核 `getRun(jobId).phase`（已为 cancelled）→ ALIVE 分支把行写回 `status:"running"` 并用远端 stderr **覆盖掉刚追加的 `[stop] cancelled via node stop` 标记**（之后 sweep 按 phase 过滤跳过该 run → 僵尸 running 行直到重启 boot reconcile）；EXIT≠0 分支则把 cancelled 翻成 failed（badge 条件 `phase==="cancelled"` 失配 → 双向 badge 丢失，用户停止被误标为失败）。节点侧终态不受影响（C+E 完好）——纯 ToolJob 可见性损失。
- 修复建议：`applySweepBlock` 入口复核当前 run phase（终态即跳过全部行写）；sweep 行写改条件化（`where status:"running"`），与节点 lane 的条件写纪律对齐；或把标记写入挪进 `stopClusterJob`（单点写入，紧跟自己的 updateJobRow）。

### P2-2【F6】陈旧 nodeIds 只在"下一次组编辑"时才剪枝；持久化失败静默吞掉

- 文件：`src/components/canvas/node-group.tsx:42-46`（剪枝仅存在于 scheduleGroupPersist）。
- 机理：删除节点 / 模板加载 / JSON 导入（全部换新节点 id）后，DB 里的组 nodeIds 全为陈旧引用——渲染层按 live 成员过滤（`:158-159`）不可见、无法选中删除，**永远留在库里**，直到用户做任意一次组编辑（整列替换 payload）才顺带清掉。且 persist 的 `.catch` 只兜网络错误，非 2xx（如 >32 组的 400）被静默丢弃 → 本地编辑在下一次 hydrate 时被服务端旧值覆盖丢失。
- 修复建议：节点删除（inspector / 批量删除）后安排一次轻量 persist（或服务端在 node DELETE 路由顺带过滤 groups JSON）；persist 对 `!res.ok` 至少 console.warn / toast。

### P2-3【F6】PATCH 路由两处注释自相矛盾（`groups: null` 语义）

- 文件：`src/app/api/workflows/[id]/route.ts:14-15`（头注释 "null/[] clears"——与实现一致）vs `:70-72`（内联注释 "`groups: null` / undefined → no change"——与实现**相反**：body 显式含 null 时 `sanitizeGroupsJSON(null)→null→data.groups=null` → **清列**；仅"字段缺省"才是不变）。
- 影响：当前无调用方发 null，纯文档地雷；后续若有人按内联注释实现调用方会意外清空组层。
- 修复建议：改内联注释为"`groups` 缺省 → 不变；显式 `null` 或 `[]` → 清空（写 NULL / "[]"）"。

### P2-4【F7】stream settled 分支水位用事件发射时刻而非行写时刻

- 文件：`src/app/api/workflow/nodes/[id]/stream/route.ts:210`。
- 机理：Node 模型带 `@updatedAt`，reconcile 的 updateMany 刷新了行时间；`new Date()` 比真实行写时间晚（poll+写延迟）→ 水位被高估。今天无实害（P1-3 指出该值根本没被落盘，仅参与守卫比较），但一旦按 P1-3 落盘，高估会误拒紧随其后的合法写（同毫秒 Retry 边界）。
- 修复建议：settled 时重读行（或复用写入时刻）传 `current.updatedAt`。

### P2-5【F5】patchEdgeGroups 每帧 O(E²) 查找 + 拖拽中 React 重渲染的单帧锚点闪变

- 文件：`src/components/canvas/edge-drag-patch.ts:63-68`。
- 机理：每帧对每个 geom 做 `workflow.edges.find`（O(E²)）+ 两次 Set 分配。按声明的规模（成员 ≤8、边 ≤几十）约 1600 次字符串比较 + ≤2500 次 find/帧，远低于 DOM setAttribute 开销——**当前规模可接受**；边到数百才需要 Map 化。另：拖拽中若发生 store 写（如成员经 SSE 完成）触发 EdgesLayer 重渲染，该帧用 layout 锚点（无 drag）重算、下一帧 rAF 再用 raw 锚点覆写 —— 单帧锚点空间互换的闪变（预存闪变族，被 P1-1 的锚点不一致放大）。
- 修复建议：与 P1-1 一并处理（Map 化 + 锚点统一后闪变自消）。

---

## P3 / 备忘（不计级）

1. `canvas-utils.ts:49` `getLiveDrag` 导出后全仓零消费（防御性 API 形同虚设；`setLiveDrag` 写了没人读——预存设计，本轮保持）。
2. `node-search.tsx:58-72` 双 rAF 在隐藏标签页不触发（rAF 暂停）→ 跳转重定心延迟到回到前台；纯体验边界。
3. F1 确认框打开期间工作流若被清空，accept 按钮文案实时变为 "Delete 0 nodes & load"（计数是活订阅，诚实但略怪；无害）。
4. `template-marketplace.tsx:70` 订阅 workflow 使市场对话框在 3s 轮询期间整体重渲染（模态 + 低复杂度，开销可忽略）。

---

## 已验证无问题（15 组）

**F1 模板确认对话框**
1. 状态竞态/残留：`confirmTemplate`/`confirmImport`/`confirmTmpl` 均为"捕获后清空再执行"（workflow-templates.tsx:1131-1136, 1147-1152; template-marketplace.tsx:374-378），Radix Action 的自动关闭与 onConfirm 双触发无冲突；取消路径 `onOpenChange(false) → null` 无残留；AlertDialog 遮罩阻断底层面板指针 → 双确认框不可能同时打开；`loadingId`/`installingId` 双入口守卫（请求时 + 执行时）防重入。
2. 空工作流直载路径：`needsTemplateConfirm(workflow?.nodes?.length)` 对 undefined/null/0 均 false（`?? 0` 收敛）→ 直接加载/导入，无需确认——无节点可毁时语义正确。
3. marketplace TDZ 修复保持：`installTemplate`（:88）定义先于 `requestInstall`（:212），useCallback 依赖 `[installingId, installTemplate, workflow]` 完备；installTemplate 内部用 `getState()` 读 workflow（无陈旧闭包）。
4. `runImport` 拆分：parse 错误在 handleImportFile catch 呈现、运行错误在 runImport 自身 catch 呈现，直连路径无双 toast（runImport 不再抛出）；`importing` 双重守卫。
5. 嵌套对话框层级：AlertDialog 走 Portal 到 body（z-50，DOM 序在父 Dialog 之后）——与 Task 28 E2E-8 验证过的嵌套语义一致；ESC 只关确认框。

**F2 多工作流一致性**
6. dashboard-panel.tsx:97-102, 149：`workflow = activeWorkflow` 别名保持下游零改动；loading 语义仅覆盖四卡 fetch（工作流卡原先也是"fetch 期间显示空态"，等价无回归）；名称 Badge（:283-287，max-w-180px truncate）随切换即时更新；状态条改为活数据（改进）。
7. 遗漏消费点清零：全仓 `/api/workflow`（裸）消费仅剩引导/回退形态——page.tsx:193（boot）、workflow-canvas.tsx:300（防御性 boot，`if (workflow) return` 守卫）、workflow-io.ts:240（导入无 id 回退）、new-screening-dialog.tsx:108（回退）、sidebar.tsx:128（无活动工作流回退）；pi-copilot/header/runs-sheet/command-palette/canvas-toolbar/sweep-dialog 全部按 `/api/workflows/{id}` 取数。
8. sidebar.tsx:124-128：refetchWorkflow 按激活 id + 回退，注释明确契约。

**F3 ToolJob cancelled 双向 badge**
9. C+E 不变量保持：新增的集群 lane `db.toolJob.update`（stop route:57-65）带 `.catch(()=>{})`，本地 lane 更新（:84-92）及 findUnique 异常均被 `stopLinkedJob` 外层 try/catch（:94-96）吞为日志 note；`stopLinkedJob` 永不抛 → 节点原子翻转（updateMany where running/pending，:126-134）无条件可达；新写点全部位于翻转**之前**。
10. 判定与展示：标记常量唯一写入方是节点 stop 路由（jobs/:id/stop 自有面板通道不写 → 裸 cancelled 与 via-node-stop 可区分）；集群 lane 的 cancelled 状态由 `stopClusterJob` 落（cluster-run.ts:960-964），标记随后追加；cluster-panel.tsx:940-948 phase fallback 补 cancelled（原映射 running）；alphafold jobPhase（:232-247）原生处理 cancelled；两处 `viaNodeStop` 条件 `phase==="cancelled" && isCancelledViaNodeStop(stderr)`（cluster:950 / alphafold:2100）；jobs 列表路由 stderr 不切片（:64）→ 末尾标记必然可达；stderr 展示条件放宽到 cancelled 正确（含标记行可见）。
11. 判定函数 `(stderr ?? "").includes(...)` 对 null/undefined 安全。

**F4 空态引导**
12. 单次读取纪律：inline-results.tsx:487-498 的 async then 中 `r.ok` 分支 `return r.text()`（成功路径由下一 then 消费）、错误分支 `await r.text()` 后 JSON.parse 字符串——body 每分支恰读一次，无重复消费；superpose-dialog.tsx:120-135 同型（text→parse→throw）。文案触发串 `File not found on disk` 与两个文件路由的错误文本精确子串匹配（tools/file/route.ts:59,74,92；jobs/[id]/file/route.ts:59）；superpose 后端错误路径的 JSON 提取（:126-131）把 API 原话带进 error → 引导正确触发；compareStructures 自身错误不含该串 → 不误触。

**F5 组卡 liveDrag（提取保真度与清理）**
13. 提取逐行比对：`collectEdgeGroups`/`patchEdgeGroups` 的过滤语义（单 id 的 `!== nodeId` 与 `!Set.has` 等价）、DOM patch 序列（`[data-e="d"]`/motion path/src cx,cy/tgt cx,cy/grad x1,y1,x2,y2）与原 node-card 私有实现完全一致；node-card 无残留（旧函数整体删除，import 切换共享模块，`computeAllEdgeGeoms` import 一并移除）；node-card `edgeDomRef` 生命周期保持（首次显著移动填充、pointerup 清空）；sweep-group-card 的 pointerup（:197-270）与 pointercancel（:272-281）均完备清理 rAF/transform/liveDrag/edgeDomRef；释放提交用最新 live 行（mergeNodes + 逐节点 PATCH + 包围盒 clamp，防陈旧 DTO 覆盖服务器状态——QA 23-a P2-③ 语义保持）。

**F6 手绘组持久化（契约面）**
14. 往返契约闭环：4 个 WorkflowDTO 生产者（workflow/route、workflows/route、workflows/[id]/route、restore route）全部带 `toGroupDTOs`；全部客户端 setWorkflow 路径要么从这些路由取数要么 spread 既有 workflow（groups 引用恒保持：mergeNodes/setNodeStatus/upsertNode/历史 apply/删除回滚均为 spread）；3s 轮询只动 nodes/edges **不会**覆盖 groups；workflow 删除时组随行级联（列在行上）；restore 逐 id 复建节点（restore route:99）→ 组 nodeIds 可重新匹配（与 sweepGroup 存活性语义一致，注释如实）；sanitize 注入面有界（32 组 / 100 ids / label 64 / id 40 / color 白名单 / JSON.stringify 无裸拼接）；空层持久化 `"[]"` → 读回 `[]` → hydrate 一致（"清空"语义成立）；同帧 mutation+refetch 受 `persistPending` 保护（effect 在渲染后运行，标志已同步置位）；hydrate 比较含长度+顺序+逐字段（内容级判定，无引用误判）。
15. **F7 误杀推演**（见 P1-3 附带论证）：Retry failed→pending→running 全链放行（pending 显式排除 + running 事件水位新于 pending 行写）；Stop/watchdog 写终态不触发守卫；undo/redo 走 setWorkflow 绕过；C3 恢复 completed DTO（终态）跳过；"删除 completed→Ctrl+Z" 时 existing 不存在 → 守卫跳过 ✓；`setNodeStatus` 对无 rowUpdatedAt 的旧调用方放行（`rowUpdatedAt &&` 短路）——现存 5 个调用点（inspector SSE 传参 / onRun 乐观 / onRun 失败 / node-card 两处）全部兼容；node-search 双 rAF 在 Inspector 引发的 canvas resize 提交后测宽，消除跳转偏移。

---

## 交叉回归结论

- `setNodeStatus` 全部调用点（5 处）新参数可选，无破坏；签名变更向后兼容 ✓。
- `LiveDrag` 形状变更封闭：`getLiveDrag` 零外部消费者；`edges-layer` 不传 drag；minimap 不涉 drag；node-card 无旧形状残留 ✓。
- `drag.ids.includes` 每帧 4×E×|ids|（≤8 成员）+ 每帧 Set ×2 + edges.find O(E²) —— 声明规模下可接受（P2-5 记录了规模化边界）✓。
- tsc（src/ 零错误，4 条预存 examples/skills）与 eslint（零告警）与审查前一致 ✓。
- Prisma client 已再生成、custom.db 含新列（运行时探针通过）✓ —— 唯一例外是基线库（P1-4）。

## 建议的后续动作（e2e / 修复排期）

1. **P1-4 立即处理**（提交前）：重冻 demo 基线或 reset 脚本加列校验；随后实跑一次 `demo:reset --force` + dev 重启 + GET / 验证。
2. P1-1 修复后按不变量"卡内 button 必须真实指针实测"补 e2e：折叠组真实指针拖拽（首帧边不跳、拖拽中边贴卡、释放落位）+ 375px 触屏。
3. P1-2 修复后补切换竞态实测：画组 → 600ms 内切换工作流 → 断言两侧 groups 列均不变。
4. P1-3 修复后复现 #6：单节点 run + 人为延迟 POST 响应 → 断言 pill 不回退。
5. F1 三个确认框真实指针路径（模板/导入/市场各一 + 取消 + 空工作流直载），确认 marketplace 嵌套 Dialog 的 ESC 序层。
6. P2-1 修复后在 cluster 面板开启轮询时 Stop 一个集群节点，断言 badge 与行状态。
