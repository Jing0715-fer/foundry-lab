# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性）、
> 10-11（F 线 P1 打磨与运维）、10-12（G 线验证通道与生产化，QA 审查闭环 + 集群 e2e 通道 +
> 浏览器级 e2e）八轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep 系统 + A/B/C/E/D/F 线**（详见 git 历史与 README）：参数扫描、对比视图、一键 campaign、
  组卡、DAG 并行执行、看门狗/中止/重试、undo 状态、溯源深链、演示数据治理、Superpose 3D、
  cdr_h3_length 亲和力成熟、报告/CSV 导出、失败三车道 pill、模板加载确认、多工作流一致性、
  手绘组持久化、liveDrag 渲染空间锚定、竞态守卫（F 线七项）。
- **G 线 · 验证通道与生产化（本轮交付，四项）**：
  - **G1 集群 e2e 通道**（`bun run e2e:cluster`，`scripts/e2e/cluster-lane.ts`）：把集群执行
    通道的全部关键承诺搬进**一条可复现的命令行验收**——直连模式真实远程执行（真 ssh2 SSH 到
    mock-cluster → 真实 numpy 引擎 → 对账 sweep → 输出同步回本地 outputs/ → 节点 completed 带
    ##OUTPUTS##）；节点 Stop → `stopClusterJob` 单点写入（cancelled 行 + `[stop] cancelled via
    node stop` 徽标）+ **远端进程真死**（/proc + starttime 比对）+ **sweep 终态守卫**（两轮
    sweep 不复活）；Slurm 模式（sbatch → squeue/sacct 判定 → 同步回收）；poll-ceiling 交接 →
    SSE 流 reconcile 落定（completed/cancelled 双映射）+ **co-driver 真阳性**（无 jobs-list
    轮询器时仅靠流式 sweep 落定）。测试自带 P6 清理 + 基线恢复 + **P0 自愈**（冻结基线参照：
    崩溃残留的工作流/ToolJob 行/连接/记录/目录重跑收敛）。全模式 **77/77 PASS**、基础模式
    **51/51 PASS**、`--keep` 现场保留跑（供徽标浏览器复核）+ 复跑收敛全绿。
  - **G1 配套生产加固**：① `FOUNDRY_CLUSTER_POLL_CEILING_MS` env（按次读取，仅正有限值生效）
    使 poll-ceiling 交接可复现测试；② **SSE 流 sweep co-driver**——节点带集群标记运行时，流
    自身每 ~3s 驱动一次（re-entrant 守卫 + fire-and-forget），关闭"只有 cluster 面板轮询才推进
    ToolJob 行"的缺口（e2e P5c 唯一断言实证）；③ **sacct 分隔符 bug 修复**（e2e 发现：真
    `sacct -P` 与 mock 均以 `|` 分隔，旧的逗号 split 把整行当 state——slurmState 存整行、
    sacct 判定全落到 vanished；现 `split(/[,|]/)` + `CANCELLED by <uid>` 前缀匹配）；④
    **applySweepBlock 快照竞态修复**（QA P1-1：stop 在 sweepInFlight 之外运行，进行中的 sweep
    读到旧快照会用无条件写把刚取消的行覆盖回 running——现 live 重读 + 所有 sweep 行写
    条件化 `updateJobRowIfSweepable` + syncBack 出口 phase 复核，stop-vs-sweep 压力实证）。
  - **G1 mock-cluster 补全**：新增 loopback 调度器端点（127.0.0.1:3023/sched）+
    `fs/opt/bin/{squeue,sacct,sinfo,scancel,sbatch}` 文件 shim（`shims/sched-client.ts`）——
    sweep 把调度器调用嵌在命令替换 `$(squeue …)` 里，真 bash 走 PATH 解析，而 mock 只拦截
    顶层独立段；shim 进程经 loopback 读同一内存态调度器（一态两门），兑现 mock README 的
    既承诺（"嵌套调用由文件 shim 覆盖"）。EADDRINUSE 降级不崩溃。
  - **G2 组层 UI 完善**（#22）：组框可选中（✎/× 按钮——**pointerdown stopPropagation 修复**：
    QA 实证画布背景 setPointerCapture 会吞掉组框 onClick，修复前组选择在真实浏览器里是死
    代码）；✎ 打开内联**重命名/换色编辑器**（maxLength 64 对齐服务端校验、Enter 提交/Esc
    取消/blur 条件提交、色点即时提交保持编辑器开启、双击防穿透）；成员全部折叠时组框淡化为
    **ghost 幽灵框**（贴聚合卡、`N folded` + 展开提示、可选中可编辑、折叠判定对齐
    deriveSweepGroups 的 ≥2 成员规则）。浏览器级实测：建组 → 真实指针选中 → 编辑器 → 重命名
    换色 → DB PATCH 落库 → reload+切回 hydrate 恢复；ghost 渲染/选中/编辑全过。
  - **G3 P3 备忘清理**：`getLiveDrag` 零消费删除（write-only 语义成文）；NodeSearch 双 rAF
    加隐藏标签页兜底（document.hidden → 宏任务，注释披露浏览器 clamp）；Marketplace 订阅
    收窄（三个原始值 selector 替代整 workflow 对象——3s 轮询不再重渲染整个模态）。
- **QA 闭环（34-a 审查 → 34-b 修复）**：P0×1（**`.env` 是入库文件**——测试 env 必须走
  .gitignored 的 `.env.local`，否则 8s ceiling 变仓库默认；CONTRIBUTING 运行手册已改）+
  P1×2 全修（快照竞态 + tsc 门禁 4→7 回归——Bun ambient 声明 + `export {}`）+ P2 精修 8 条
  （编辑器双击穿透、ghost 折叠语义、mock 端口降级、e2e 自愈/诊断/清理收窄、sacct
  CANCELLED by、pidDead starttime、shim 权限）。审查报告：`qa-review-g-lane.md`。
- **E2E（Task 35，浏览器级 + DB 级）**：G1 三种 e2e 模式全绿；G2 真实指针全链路（含修复的
  实证）；G3 NodeSearch 精确居中（delta 0,0，Inspector 开启后 800 宽画布正中心）；Cluster
  面板 `via node stop` 徽标（真实 cancelled 行：`rfdiffusion · cancelled · via node stop ·
  foundry@localhost · direct`）；移动端 375 零溢出 + footer 780/812 贴底；console/page/
  dev.log 零错误；演示 DB 基线字段级核对零污染（2/19/16/0）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1-22 | （承上轮：Sweep/A/B/C/E/D/F 线结论与 e2e 工程标准——见 git 历史版本） | — | 已交付 |
| 23 | **G1 集群 e2e 通道全绿**：四承诺（派发/sweep/同步回收、Stop 单点写+远端杀+终态守卫、slurm 判定链、poll-ceiling 交接+co-driver）全部拿到引擎/文件/DB/流式事件级证据；一条命令可复现，P6 自清理 + P0 自愈（冻结基线参照）使崩溃重跑收敛 | #21 闭环 | 已交付 G1 |
| 24 | **sacct 分隔符 bug**（e2e 发现）：真 sacct -P 与 mock 均以 `|` 分隔，逗号 split 把整行当 state——正常完成全靠 .cf-exit 阶梯兜底，sacct 判定链从未真正工作 | 集群诚实性 | 已修复（e2e 断言 slurmState=COMPLETED） |
| 25 | **mock 顶层拦截盲区**：调度器调用嵌在命令替换/脚本内时走真 bash PATH——需 loopback + 文件 shim（一态两门）补全；mock README 的"嵌套由 shim 覆盖"承诺此前未兑现 | 测试装置保真 | 已交付（P4 断言链） |
| 26 | **P1-1 stop 与 in-flight sweep 竞态**：`run` 是 sweep 开始时的快照，`updateRun` 换对象；stop 在 sweepInFlight 之外——进行中 sweep 的 ALIVE 分支会用无条件写覆盖刚取消的行（僵尸 running 行 + 徽标丢失）。**执行通道不变量（条件写）必须覆盖 ToolJob 行写，不只是 Node** | 集群数据可信 | 已修复（live 重读 + 条件化 + 压力实证） |
| 27 | **P0：`.env` 是入库文件**——测试 env 写进去会变成仓库默认（8s ceiling 即"每次真实集群跑都 8 秒交棒"）。测试 env 一律 `.env.local`（gitignored + 优先级更高） | 运维/提交卫生 | 已闭环（CONTRIBUTING 成文） |
| 28 | **e2e 选择器同名陷阱**：调色板搜索框 placeholder 就是 "Search nodes…"（NodeSearch 是 "Search nodes by name, type, or status..."）——`includes('Search nodes')` 两个都命中，本会话 NodeSearch 断言一度误打到调色板 | e2e 工程标准 | 验收参考（用完整 placeholder 区分） |
| 29 | **Radix footer 坐标点击静默落空再现**（分组提示框 Create 按钮）+ **"N selected" 浮条会遮挡其锚点区域的目标**（sweep 徽标点击被吞）——副作用断言不可省；DOM click 兜底 + 先清浮条 | e2e 工程标准 | 验收参考 |
| 30 | **组框 stopPropagation 的交互代价**：从组框上起步的平移/框选不再生效（点击优先于拖拽面）；e2e 拖拽必须从"真背景点"起步（需 elementFromPoint 验证不在 frame/card 上） | e2e 工程标准 | 验收参考 |

## H 线 — 科研深度与可及性收口（P1，下一阶段建议）

1. **叠合深化**（D 线 P2 提级）：候选详情单卡直接发起叠合（当前需经 Compare）；叠合
   swap 按钮（参考/移动互换）；叠合 RMSD 作为可加权筛选指标（写入 campaign 指标体系）。
2. **键盘可达组层**（QA 34-a P2-4）：组选择/编辑目前仅鼠标可达（frame onClick）；沿用
   sweep-group-card 先例（role=group + 真按钮）给组框键盘路径。
3. **ghost 视觉边界**（QA 34-a P2-3a/b）：成员跨两个 sweep 聚合的组 ghost 会横跨中间地带；
   E3 拖拽中 ghost 静止到落点（视觉滞后）——均为纯视觉项，按需打磨。
4. **认证与团队协作**（NextAuth）：工作流 / campaign 共享与操作审计（依赖面大，视进度弹性）。
5. **叠合的集群/本地引擎对称性**：叠合当前纯客户端；大结构（>5K 残基）考虑 worker 线程。

## 验收标准（延续并扩充）

- 每项新功能必须：API 冒烟（无效输入全 400/404/409）+ 浏览器 e2e（真实引擎、真实输出、
  文件/DB 级证据）+ undo/redo DB 一致性检查。
- **集群通道任何改动必须跑 `bun run e2e:cluster`（基础）+ 完整模式（ceiling，见
  CONTRIBUTING 集群 e2e 节）**——sweep/stop/同步/交接的语义回归由这条通道守门（#23）。
- **执行通道任何新增写点必须条件化**——本阶段已扩展到 **ToolJob 行写**（`where status
  notIn terminal`，sweep 所有出口；Stop/看门狗落定不可复活是既定不变量，第六/七轮实证）；
  集群 sweep 的行写同样不得覆盖终态（applySweepBlock 入口 + 出口双守卫）。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（setPointerCapture 会吞掉派生
  click，JS click() 测不出——B 线教训；对话框内 shadcn 按钮可用 JS click，节点卡选择必须
  物理指针；**Radix footer 坐标点击必须验证副作用**——本会话 Create 按钮再次落空）。
- **e2e 选择器用完整 placeholder/测试钩子区分同类元素**（"Search nodes…" vs "Search nodes
  by…"——#28）；**浮动 UI（选中条/toast）可能遮挡锚点区域目标**，交互前先清场（#29）。
- **拖拽/点击 e2e 前必须 elementFromPoint 断言落点在目标上且不在拦截层上**（组框
  stopPropagation 会吃掉从组框起步的平移——#30；React 18+ 批处理吞同 eval 事件序列——
  setTimeout 间隔派发）。
- **客户端终态仲裁镜像**：晚到的 SSE/POST 快照不得把本地终态打回非终态（updatedAt/
  rowUpdatedAt 水位 + upsertNode/setNodeStatus 守卫）。
- **demo:reset / db 变更后必须重启 dev server**（守护器）——陈旧 Prisma client 之外还有
  **陈旧 inode** 事故形态；**schema 变更必须与重冻基线同 commit**；**测试 env 一律
  `.env.local`，绝不写入入库的 `.env`**（#27）。
- **多工作流场景必测**：任何"取节点/取统计/取组"的新 UI 必须在非首工作流下验证。
- **移动端宽度检查用 main 宽度而非页面 scrollWidth**（overflow-hidden 裁剪假阴性）；375px
  必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底。
- 演示 DB 卫生：e2e 后字段级核对（节点/边计数、screening 权重、ToolJob 行数、连接注册表
  ——集群 e2e 的 P6 已内建该核对并自愈收敛）。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/ + scripts/ + mini-services）零新增、
  dev.log 无运行时错误、e2e 截图 VLM 复核（截图前断言目标 UI 在 DOM）。
