# QA 深度审查报告 — H 线未提交改动（Task 38-a）

审查对象：工作树 vs HEAD（fad8c98）的全部未提交改动 —— 11 个修改文件 + 1 个新路由。
方法：git diff 逐文件精读 + 新文件全文通读 + 交叉验证（deriveSweepGroups/layoutNodes/collectEdgeGroups/全局键盘监听/Tailwind v4 编译产物/基线 DB 只读探针/live 只读 HTTP 探针/tsc/lint）。未修改任何源代码，未运行任何写 DB 的脚本。

**结论先行：无 P0。三个 P0 候选项全部降级或证伪（见 P1-3 与「已验证无问题」清单）。实出 3 个 P1（其中 H2 键盘 1 个、H3b 1 个、H1c 数据一致性 1 个）+ 9 个 P2。工具链全绿。**

---

## P1（建议 Task 39 e2e 前先修）

### P1-1 · H2：frame onKeyDown 劫持子交互元素的 Enter/Space —— ✎/× 按钮键盘死键
- **位置**：`src/components/canvas/node-group.tsx:457-467`（frame onKeyDown）× `node-group.tsx:490-512`（✎ 编辑 / × 删除按钮，为 frame 子元素、无自己的 onKeyDown）× `node-group.tsx:607-614`（GroupEditorPanel 重命名 input）。
- **机理**：键盘焦点落在 ✎/× `<button>` 上按 Enter：keydown 冒泡先到达父 frame 的 onKeyDown → `e.preventDefault()`（**取消 button 的原生激活默认行为**，click 永不触发）+ `setActiveGroup(toggle)` → frame 反而被反选、按钮随 isActive=false 卸载。Space 同理（取消激活）。重命名 input 的 Enter 虽在 input 自身 handler 先 commit+close，但事件继续冒泡到 frame（panel 层只 stopPropagation Escape，`node-group.tsx:578-584`）→ commit 成功的副作用是 frame 被意外反选。
- **后果**：H2 自己宣称的「once selected, the edit/delete buttons are real <button>s reachable with Tab」——可达但**不可键盘激活**；纯键盘用户无法编辑/删除组（Delete 全局键只删节点不删组）。与 sweep-group-card pointerdown 的交互子元素排除清单（`sweep-group-card.tsx:131-137`）同构的问题，键盘侧漏了。
- **修复建议**：frame onKeyDown 首行加
  `if ((e.target as HTMLElement).closest("button, input, [contenteditable='true'], [role='button']")) return;`
  （并同步给 input 的 Enter 分支补 stopPropagation，或在 frame 层统一排除）。
- **e2e 必测**：真实键盘事件（CDP dispatchKeyEvent/page.keyboard）Tab 到 frame → Enter 选中 → Tab 到 ✎ → Enter **必须打开编辑器而非反选**（当前实现必失败——这正是 e2e 要抓的）。

### P1-2 · H3b：无边聚合卡拖拽时 ghost 不跟随 —— setLiveDrag 被边存在性门控
- **位置**：`src/components/canvas/sweep-group-card.tsx:181-202`（rAF 回调里 `setLiveDrag` 位于 `if (edgeDomRef.current) {}` 块内）× `src/components/canvas/edge-drag-patch.ts:29-46`（`collectEdgeGroups` 在**无任何相连边**时返回 `null`，:46 `return any ? map : null`）× 订阅端 `node-group.tsx:373-385`。
- **机理**：聚合卡首次显著移动时 `edgeDomRef.current = collectEdgeGroups(memberIds)`（:161）；若该聚合**没有任何相连 edge**，返回 null → 后续每帧 `if (edgeDomRef.current)` 为假 → `setLiveDrag` 从不调用 → node-group 的订阅回调从不触发 → ghost frame 停在原地，聚合卡自己滑走（卡片自身 transform 在 guard 外，:175-177，正常移动）——**恰好是 H3b 要修的那个视觉 bug，在无边场景原样存在**。`node-card.tsx:202-206` 同一 guard（对 ghost 不可见，因 folded 节点不可单卡拖拽，无用户可见影响）。
- **修复建议**：把 `setLiveDrag({ids, dx, dy})` 移出 `if (edgeDomRef.current)` —— 它是共享拖拽状态的唯一写者（H3b 的语义根基），不应以「有边可补」为前提；`patchEdgeGroups` 保留在 guard 内即可（空 Map 也无副作用，或保留 null guard 仅护边补丁）。
- **e2e 必测**：两组 A/B——(A) 有边聚合卡真实指针拖拽中 `evaluate` 断言 ghost `style.transform` 非空、drop 后清零；(B) **无边**聚合卡同样断言（当前实现必失败）。

### P1-3 · H1c：computeRmsdAxis 非事务读-改-写 + rmsdRefId 后置持久化 → 竞态/中断下「参考指向」可撒谎
- **位置**：`src/lib/screening.ts:1256-1293`（逐候选 `update metrics` 循环 + :1292 才写 `rmsdRefId`）× `src/app/api/screening/[id]/rmsd/route.ts` × 注释 `screening.ts:1296`。
- **机理（三个窗口）**：
  1. **并发双算**：同一 screening 两个并发 POST（双标签页/双用户；单客户端被 rmsdBusy 单飞保护，跨客户端无锁）→ 两份快照交错逐行写 → 各行 rmsd 混两参考的值，`rmsdRefId` 归最后完成的 `db.screening.update`（:1292）→ **chip 标注的参考与行内数值不一致**（DTO 承诺「never lies about which structure」被破坏）。
  2. **中途崩溃**：循环中途任一 update 抛错（DB 错误/进程重启）→ 部分行已带新参考值、`rmsdRefId` 仍指旧参考 → chip 撒谎（同上）。
  3. **删除竞态 + 注释失实**：screening 被级联删除（`schema.prisma:292` Cascade）发生在循环中 → 下一次 `screeningCandidate.update` 抛 Prisma P2025 → route 落 500 + 原始 Prisma message（诚实但粗糙）；:1296 注释「screening deleted mid-compute — route 404s」**仅在删除发生于 :1292 之后的极窄窗口成立**。
- **为何降级 P0 → P1**：metrics 列的**唯一**既有写者是 computeRmsdAxis 自身 —— patchCandidates（star/status/notes/tags，`screening.ts:1706-1743`，事务内）写的是**其他列**，Prisma update 只写 data 指定列 → 「与 patchCandidates 丢更新」窗口**不存在**；promote 只写 status（:1900-1903）；rescan 只 createMany 新行。单用户正常流无可达的数据丢失路径；破坏均需并发双算或中途崩溃。
- **修复建议**：两阶段——先纯计算全部 rmsd 值（无任何写），再单个 `$transaction` 内批量 update + `rmsdRefId` + defs/weights 刷新；P2025 catch 后映射 `ScreeningError(..., 404)`。顺带把逐行写改为批量可显著缩窗。
- **e2e 建议**：双 POST 并发压测（可选，断言最终一致性或串行化）；404/400 路径已 live 只读验证（见下）。

---

## P2（不阻塞 e2e，建议 H 线收尾批处理）

### P2-1 · rmsdRefPick 不随 campaign 切换重置 → 跨库陈旧选择
- `src/components/panels/screening-panel.tsx:250-259`（切库重置 effect 漏掉它）× :757（声明）× `controls-column.tsx:385-388`（`value={rmsdRefPick || rmsdRef?.id || undefined}`）。
- 切到另一 campaign 后 rmsdRefPick 仍是旧库候选 id：Select 显示回 placeholder，但 Compute 按钮可用（rmsdRefPick 非空）→ POST → 404「Reference candidate not found」。服务端诚实，UX 困惑。**修复**：reset effect 加 `setRmsdRefPick("")`。

### P2-2 · computeRmsd 静默丢弃未保存的本地权重编辑
- `screening-panel.tsx:778` `setWeights(initWeights(data?.screening ?? null))` —— 计算 success 后用服务端权重（含新播种的 rmsd 默认权）覆盖本地 state；用户若正有未 Save 的滑杆调整会被无声丢弃（dirty 标志同时归零）。建议：仅合并新增键（`{...weights, ...新键默认值}`）或 toast 提示。

### P2-3 · Escape 冲突矩阵：frame 激活时 Escape 吞掉 live-wire 取消
- `node-group.tsx:462-465`（Escape stopPropagation，仅 isActive 时）× `live-wire.tsx:37-39`（window Escape → cancelConnect）× `src/app/page.tsx:296-324`（全局 Escape：取消连线/关 Inspector/取消选中）。
- pending 连线 + frame 被选中（点击 frame 即发生）时按 Escape：先反选 frame（连线仍悬着），需**第二次** Escape 才取消连线。语义可辩（Escape 总在清一层），但应作为已知矩阵记录；同理 frame 激活时全局 Escape 的「取消节点选中」也被屏蔽（合理——焦点在组上）。无 Enter/Space 与全局快捷键冲突（全局注册的是 Delete/Backspace/Escape + mod 键组合，`page.tsx:282-328`、`workflow-canvas.tsx:126-163` 均有 mod 守卫）。

### P2-4 · 注释失实三处（不动行为，动文档）
1. `node-group.tsx:397-402`：称 stopPropagation「keeps these keys away from the window-level canvas shortcuts (Ctrl+F/Ctrl+G)」——handler 只处理 Enter/Space/Escape，**根本看不见** Ctrl+F/G；这两个 mod 组合在 frame 聚焦时正常穿透生效（这其实是期望行为，注释描述的威胁模型反了）。
2. `node-group.tsx:183-186`：称「Same a11y shape as the sweep-group-card precedent」——sweep-group-card 只有 role+aria-label（`sweep-group-card.tsx:295-296`），**没有 tabIndex/键盘 handler**；组 frame 是画布上第一个真正键盘可操作面。node-card 也无 onKeyDown（rg 全 canvas 目录仅 node-group 新增）。宣称的「先例」不存在。
3. `superpose-dialog.tsx:77-80` vs :88-90：注释称「Reset whenever the dialog closes or the caller supplies new entries」；代码只 `if (!open) setSwapped(false)` —— entries 变更+open=true 不重置。实际不可达（Radix 模态挡住父层交互，新 pair 必经 close），但注释与代码不符。

### P2-5 · H1c 语义备注（设计决策，非 bug——建议记录/可选增强）
1. **参考 rmsd=0 锚定域**：参考参与 metricDefs 域计算（min=0 恒定），其余候选归一化区间被压扁（0/14.85/17.44 → 1/0.15/0），且参考在 rmsd 轴恒满分、重权重下恒 rank 1。**不是撒谎**——chip 明示「Axis reference: X (rmsd 0 Å)」（`controls-column.tsx:346-353`）、RMSD-to-reference 本就是「与参考相似度」排序语义；但可考虑把参考排除出域计算（或排序），至少在 ROADMAP 记录该取舍。
2. **rescan 后混合**：rescan 只增不删（`screening.ts:1585-1586`）→ 新候选无 rmsd 键 → 计分时跳过+权重重归一（`scoring.ts:89-101`，诚实），chip 仍指旧参考。可选：UI 提示「N 个新候选尚无 RMSD，请重算」。
3. **键名空间**：引擎若产出字面 `rmsd` 指标会与本轴合流（METRIC_REGISTRY 接管 label）——现有引擎无此键，低风险，记录即可。
4. **wsum=0 退化**：全员缺键 → 该行 score 0 是**预存** computeScores 行为（`scoring.ts:101`），非本轮引入；rmsd 全员失败时 defs 失去 rmsd 键（`computeMetricDefs` 只统计在场值，`screening.ts:239-265`）→ 已存权重静默搁置（defs 迭代跳过）——诚实。

### P2-6 · 删除竞态的 500 粗糙映射 + 路由耗时判断
- 删除竞态 → 500 + 原始 Prisma message（见 P1-3 ③）：建议 P2025 → 404。
- **耗时判断（自查结论）**：冒烟 309ms/3 候选 ≈ 100ms/候选 → 60 PDB 候选 ≈ 6s + 参考读取。本项目自托管 dev/Node server——route handler **无默认硬超时**（`maxDuration` 仅 serverless 生效），浏览器 fetch 默认 ~300s，客户端无 UI 阻塞（rmsdBusy spinner）。**判定：自托管可接受**；若未来部署 serverless 需加 maxDuration 并批量化。建议在 route 头注释记录该前提。

### P2-7 · AGGREGATE_CARD_H=150 近似（预存）
- `node-group.tsx:163` 本地常量近似聚合卡实际渲染高度——ghost 联合包围盒可能不精确贴合（±几 px 余量已被 -24/-40/+24/+24 padding 吸收）。预存约定，本轮沿用，cosmetic。

### P2-8 · rmsdCandidates 不校验磁盘存在性
- `screening-panel.tsx:788-794` 只查 `!!c.pdbPath`；文件悬空（demo 基线即悬空，F4 预存）时选它做参考 → 服务端 400「needs a linked PDB file on disk」（诚实报错）。可选：options 列表过滤或标记。同因 candidate-detail H1a 的启动按钮 `disabled={!candidate.pdbPath}` 不查磁盘——点击后 superpose dialog 走「File not found」错误路径（Task 37 浏览器复核已实证，F4 预存行为）。

### P2-9 · superpose-dialog entries 变更+swapped 的理论性双跑
- entries 变更且 swapped=true 时（Radix 模态下不可达）：reset effect 与 fetch effect 同轮重跑，fetch 会先以旧 swapped 身份跑一次再被 cleanup abort——净效果只是一次被废弃的 fetch，无错误 UI（cancelled 守卫完备，`superpose-dialog.tsx:127-182`）。记录即可，不需改。

---

## 已验证无问题清单（重点复核项逐条结论）

1. **P0 候选①「computeRmsd 与 patchCandidates 丢更新」— 证伪**：metrics 列唯一写者是 computeRmsdAxis；patchCandidates（star/status/notes/tags）走 `$transaction` 且写**不同列**（`screening.ts:1706-1743`）；promote 只写 status（:1900）；rescan 只 createMany。无跨列丢更新窗口。真正的竞态收敛为 P1-3（并发双算/中断一致性）。
2. **H1b swap 语义**：`entries` 来自 state（`screening-panel.tsx:296-298`，setSuperposeEntries 存数组 → 身份稳定）→ effectiveEntries memo 不引发重复 fetch/循环；swap 依赖 `[open, effectiveEntries]` 正确重拉+abort+cancelled 三重守卫（`superpose-dialog.tsx:108-183`）；swap 按钮在 loading 时 disabled（:292）→ swap 与在飞 fetch 的 abort 竞态实际不可达且守卫完备；缺 PDB guard 在翻转后对称生效（:122-126）；swap 重对齐「不对称」语义（参考定住/移动结构着色）与 compareStructures 参数序一致（`superpose-compare.ts:152-157` ref/mobile）。
3. **H2 stopPropagation vs window 监听——断言成立**：React 18/19 事件委托挂在 root 容器（root container 位于 window 之下的 DOM 层级）；synthetic `stopPropagation()` 桥接 native stopPropagation → 原生事件止步于 root 容器 → **bubble 相 window 监听器（page.tsx / live-wire / workflow-canvas / command-palette 等全部 `window.addEventListener("keydown")` 无 capture）收不到**。唯一例外是 capture 相监听（`SequenceBar.tsx:300` `{capture:true}`——仅分子视图挂载，画布不受影响）。机制层面 H2 设计成立；实际缺陷是 P1-1（子元素劫持）与 P2-3（Escape 分层）。
4. **H2 focus ring 真实生成**：Tailwind v4 编译产物核验（`.next/dev/static/chunks/src_app_globals_css_*.css`）：`.focus-visible\:outline-2:focus-visible { outline-style: var(--tw-outline-style); outline-width: 2px }` + 全局回退 `--tw-outline-style: solid` + `outline-offset` + `outline-color: var(--color-slate-400)` → 键盘聚焦呈现 2px 实线 slate-400 外环。同族先例 `runs-sheet.tsx:125`。
5. **H2 tabIndex=0 对指针流零回归**：frame 的 pointerdown stopPropagation（G-lane 修复）原样保留（`node-group.tsx:452`）→ 从 frame 起步的平移/框选行为与改动前完全一致；tabIndex 只增加点击聚焦与 Tab 停靠，无 pointer 语义变化。
6. **H3a 数学**：`sweepOrigin` 与 `deriveSweepGroups`（`sweep-group-card.tsx:57-75`）完全镜像——对每 sweep **全部**成员做 x/y 独立 min（非配对 min，正确，因为聚合卡渲染原点就是 (minX, minY)，`workflow-canvas.tsx:721-731` layoutNodes 同源）；跨 sweep 组取 origins 联合包围盒 ±(-24/-40/+24/+24) 与 live frame padding 约定一致；partial 组贴合其 sweep 聚合卡；`origins.length===0` 防御性 continue；allFolded 的 ≥2 成员规则（P2-3c）保留。✓
7. **H3b 细节**：callback ref 块体不返回值（React 19 清理函数语义安全，无 warning）；订阅 effect `[]` 挂载一次 + cleanup 退订（StrictMode 双挂载安全）；`setLiveDrag` 逐订阅者 try/catch（坏订阅者不破坏拖拽循环，`canvas-utils.ts`）；**drop 时序正确**：`setLiveDrag(null)`（`sweep-group-card.tsx:218`）先于 `mergeNodes` 提交（:252）且同处一个 JS task → 无「transform+新位置」双偏移帧；groupBoxes effect 双保险清 transform+清陈旧 ref+刷新 membership（`node-group.tsx:360-372`）；**非 ghost 组 no-op 验证**：ref callback else 分支把非 ghost id 从 ghostRefs 删除（:434-435）→ 订阅循环只遍历 ghost → 可见组帧不受订阅影响（其拖拽后跳变为预存行为）；拖拽期间 membership 快照不滞后（位置提交前 groupBoxes 不重算）；`transition-shadow` 类不含 transform → 无过渡迟滞。
8. **H1c 服务端正确性**：失败/无 PDB → delete 键（不留陈旧/NaN，`screening.ts:1263-1283`）；`refreshScreeningMetrics` 重读**新鲜**行（非陈旧快照）→ defs/weights 与刚写入值一致（:935-952）；`compareStructures` 签名/`result.ok`+`Number.isFinite` 守卫/2 位舍入与 fmtMetricValue 一致；`rmsdRef` 防御式解析（引用被删→null，:460-468）——注：候选无单独删除路由（全仓 rg 无 screeningCandidate.delete），该防御仅对级联删除残留生效，纯防御性；CandidateLite 加宽在 4 处 select（:1175/:1521-1525/:1633-1637）+ rescan 全列 findMany（:1588-1591）一致补齐。
9. **路由契约**：`POST /api/screening/[id]/rmsd`——body 解析失败 400（**live 实证**）、refId 非 string/空 400（route + computeRmsdAxis 双守卫）、screening 不存在 404（**live 实证**，只读探针零 DB 写）、引用候选不在本 screening 404、参考无 PDB/读失败 400、ScreeningError status 透传（`screeningErrorStatus` :67-71）、非 ScreeningError → 500；返回 `{screening, candidates, scored, skipped}` 与客户端消费字段全对齐；Next 16 `params: Promise` 用法正确。
10. **DTO 数据面 live 实证**：GET /api/screening 与 GET /api/screening/[id] 响应均含 `"rmsdRef":null`（未计算前诚实为 null；db/custom.db Screening 行 rmsdRefId 列存在且全 null——冒烟写发生在隔离的 /home/z/h-lane 环境）。
11. **不变量核查**：执行通道写点（Node.status/ToolJob 条件写）零触碰（本 diff 无任何执行通道写）；Stop/看门狗零触碰；组 persist 600ms 防抖捕获式机制零触碰（node-group diff hunk 纯增量：sweepOrigin/ghost/H2 渲染属性，PendingPersist 块原样）；**demo 基线纪律满足**：prisma/schema.prisma 与 db/demo-baseline.db 同处未提交变更集（将同 commit 提交），基线含 rmsdRefId 列（只读 PRAGMA 验证），行数 2/19/16/15/3/86（Workflow/Node/ToolJob/Edge/Screening/ScreeningCandidate）。
12. **工具链**：`bunx tsc --noEmit` 全仓仅 4 条预存（examples/websocket ×2、skills/image-edit、skills/stock-analysis）——src/ 零错误、src/scripts/mini-services 零新增（当前为零）；`bun run lint`（eslint .）零输出零告警；GET / → 200、GET /api/screening → 200（只读探针）。

---

## Task 39 e2e 建议（哪些必须真实指针/真实引擎）

**必须真实键盘（P1-1 回归 + H2 验收）**：
1. Tab 聚焦组 frame（断言 focus-visible outline 类在 CSS 生效 + aria-label 文案含成员数/ghost 说明/Enter 提示）；Enter/Space 选中→✎/× 出现→Tab 到 ✎→Enter **断言编辑器打开**（修前必失败——P1-1）；Escape 反选；ghost frame 同链路复测。
2. 冲突矩阵抽查：frame 聚焦时 Ctrl+F 仍开 NodeSearch（穿透，符合期望）；pending 连线 + frame 激活时 Escape 两次才取消连线（P2-3 已知行为，断言并记录）。

**必须真实指针/CDP 拖拽（P1-2 + H3a/H3b 验收）**：
3. 有边聚合卡：拖拽中 `page.evaluate` 断言 ghost `style.transform` 为 translate(dx,dy)（非空）、drop 后归零、位置提交后 groupBoxes 重算无双偏移。
4. **无边聚合卡**：同断言（修前必失败——P1-2）。
5. H3a 几何：跨两 sweep 的组折叠后断言 ghost box = 两聚合原点联合包围盒 ±padding（`getBoundingClientRect` 或 left/top/width/height）；partial 组贴合单聚合卡。
6. 非回归：从真背景点起步的框选/平移不受 frame tabIndex 影响（Task 35 工程标准复用：elementFromPoint 验证起点）。

**必须真实引擎（H1c 链路，隔离环境勿碰演示基线）**：
7. 复刻 h1c-smoke 的真实链路（rfdiffusion → screening → POST rmsd）：参考 rmsd=0、真实差值、重算换参考无陈旧残留、scored/skipped toast、chip 标注、rmsd 列入排序/筛选/权重/CSV。
8. rescan 后新增候选无 rmsd → 重归一计分（语义断言）+ 重算覆盖。
9. 404/400 路径（已 live 只读实证，e2e 补 UI toast 断言即可）。
10. （可选，P1-3）双标签页并发双参考 POST → 断言最终态一致（修事务前预期失败，作为修复验收用例）。

**H1a/H1b（浏览器级）**：
11. 详情抽屉 Select 选伙伴 → Superpose 3D 打开（当前候选=参考）；Swap 点击 → 描述文案角色互换 + 网络重发（断言请求计数+1）→ 关闭再开 → swapped 复位（默认参考=当前候选）。
