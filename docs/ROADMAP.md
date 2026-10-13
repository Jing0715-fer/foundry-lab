# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性）、
> 10-11（F 线 P1 打磨与运维）、10-12（G 线验证通道与生产化）、10-13（H 线科研深度与可及性
> 收口，QA 审查闭环 + 浏览器级 e2e 含真实引擎与真实键盘）、10-14（J 线智能体操作
> skill 标准化）、10-15（L 线真实中止与 cancelled 语义——S/E 参考分支三块移植 + QA/e2e
> 全验证）、10-16（I 线 RMSD 轴打磨 + 执行令牌 #47 封口——含集群 e2e 双模式
> 51/51 + 76/76 与陈旧断言修复）、10-17（K 线 Skill 层运营化：Insights 聚合 + denied
> 深链 + per-agent 限流 + 慢技能异步入队，QA 51/52 容错重验 + 浏览器金路径全绿）、
> 10-18（M 线 Skill 层运营深化：M1 聊天卡深链闭环 + M2 审计保留与分页 +
> M3 动态技能注册，QA 42/42 + 浏览器金路径全绿）
> 十四轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep → A/B/C/E/D/F/G 线**（详见 git 历史与 README）：参数扫描、对比视图、一键 campaign、
  组卡、DAG 并行执行、看门狗/中止/重试、undo 状态、溯源深链、Superpose 3D、cdr_h3_length
  亲和力成熟、报告/CSV 导出、失败三车道 pill、模板加载确认、多工作流一致性、手绘组持久化、
  liveDrag 渲染空间锚定、集群 e2e 通道（77/77）、组编辑器 + ghost 框。
- **H 线 · 科研深度与可及性收口（本轮交付，六项）**：
  - **H1a 单卡发起叠合**：候选详情抽屉新增 "Structural comparison" 区块——Select 选同
    campaign 另一个带 PDB 的候选 + 一键 Superpose 3D（当前候选 = 参考，抽屉直达，不再必经
    表格双选 + Compare 对话框）。无伙伴/无 PDB 双空态；title 提示披露参考语义。
  - **H1b 叠合 Swap**：SuperposeDialog 头部 Swap 按钮（ArrowLeftRight）——参考/移动角色互换
    并重拉取重对齐（叠合不对称：参考定住、移动结构带残基偏差着色，所以互换是真实重算而非
    视觉翻转）；对话关闭复位 swapped（Radix 模态保证 [open] 覆盖全部可达路径）。
  - **H1c RMSD 可加权筛选指标**（写入 campaign 指标体系）：`POST /api/screening/[id]/rmsd
    {refId}` → 服务端 compareStructures（纯模块、仅 API route 引用、零客户端 bundle）为每个
    带 PDB 候选计算对参考的全局 Cα RMSD → **落库为候选 metrics.rmsd 真指标** →
    metricDefs 域重算 + 默认权重播种 → 排序/区间筛选/权重滑杆/CSV/Markdown 报告/Compare 行
    全套免费复用。语义：参考自身 rmsd=0 留在排名内（chip 明示）；失败/无 PDB 删键（重算不留
    陈旧值）；`Screening.rmsdRefId` 持久化（DTO 防御式解析——引用被删 → null，标签永不撒谎）。
    **原子性（QA 38-a P1-3 修复）**：两阶段——纯计算零写 + 单 `$transaction` 内批量写
    metrics + rmsdRefId（值与参考标签永不分离；并发双算/中途崩溃 → 整体一个赢家）；
    P2025 → 404。ControlsColumn 新增 "Structural RMSD" 卡片（参考 Select + Compute/Recompute
    + 参考 chip + 语义说明）。
  - **H2 组层键盘可达**：组框 focusable（role=group + tabIndex=0 + 动态 aria-label + Enter/Space
    切换选择 + Escape 取消 + focus-visible 外环）——**画布首个键盘可操作面**（node 卡与
    sweep 卡均为纯指针）。handled keys stopPropagation 阻断 window 级全局 Escape 分层；
    mod 组合（Ctrl+F/G）穿透（画布快捷键在 frame 聚焦时照常工作）。**P1-1 修复**：frame
    onKeyDown 首行 closest("button, input, [contenteditable], [role=button]") 早退——父层
    preventDefault 不再取消 ✎/× 子按钮的原生键盘激活（修复前可达但死键），重命名 input 的
    Enter commit 不再冒泡成反选。
  - **H3a ghost 联合几何**：ghost 从"组员原始坐标 min + 固定单卡尺寸"改为**per-sweep 聚合
    原点（该 sweep 全部成员的 x/y 独立 min，镜像 deriveSweepGroups）的联合包围盒**——跨两
    sweep 的组精确覆盖两聚合卡真实所在（e2e 逐像素核对：296×574 vs 旧代码 296×214 漏掉整个
    第二 sweep）；部分组（组员 ⊂ sweep）精确贴合其 sweep 的聚合卡。
  - **H3b ghost 拖拽实时跟随**：`subscribeLiveDrag` 订阅（canvas-utils 加订阅者注册表——
    同步通知 + try/catch 防坏订阅者破坏拖拽循环；liveDrag 文档从 write-only 改为
    writers/consumers 双向语义）+ ghostRefs/ghostMembersRef 双 ref——聚合卡拖拽中 ghost 经
    DOM transform 实时跟随（无 React 帧渲染，与边补丁同成本级），groupBoxes 重算时清
    transform + 清陈旧 ref。**P1-2 修复**：setLiveDrag 移出 `if (edgeDomRef.current)` 守卫
    ——共享拖拽状态的唯一写者不以"有边可补"为前提（修复前无边聚合卡拖拽时 ghost 原地不动，
    恰是 H3b 要修的 bug）。
- **QA 闭环（38-a 审查 → 38-b 修复）**：P0×0（三个 P0 候选全降级或证伪——"computeRmsd 与
  patchCandidates 丢更新"证伪：metrics 列唯一写者即本函数）；P1×3 全修（子元素键盘所有权 /
  liveDrag 写者独立 / RMSD 轴原子提交）+ P2 精修 5 条（切库重置 rmsdRefPick、权重合并式
  保留本地编辑、三处注释失实、route 耗时前提成文）。审查报告：`qa-review-h-lane.md`。
- **E2E（Task 39，浏览器级 + DB 级 + 真实引擎）**：真实键盘链路（Tab→✎→Enter 开编辑器且
  frame 不反选 = P1-1 回归通过；键盘改名 Enter 提交 → 防抖落库）；H3a 几何逐像素核对；
  H3b 无边 + 有边双场景 mid-drag 卡/ghost 同步 transform + 释放全清 + DB 精确提交（P1-2
  回归通过）；H1c UI 全链路（真实引擎 3 designs → 真实指针 Compute → 表格值与 API 逐行一致
  13.6/16.37/0 + 权重播种 + chip）；H1a 真实文件叠合（RMSD 15.14 Å + 44 对齐残基）+ H1b
  swap 角色互换重算 + 复位。移动端 375 零溢出 + footer 贴底；page/console/dev.log 零错误；
  VLM 复核两截图 PASS；演示 DB 零污染（含一处自我污染的发现与清理——tour 调色板按钮误点
  产生的 stray Input 节点）。
- **J 线 · 智能体操作 Skill 标准化（本轮交付）**：用户问"agent 层是否有 skill 机制" →
  摸底发现 8 条互不复用的操作协议 + 三个结构性缺陷（门控只在 prompt 文案层、prompt 与执行
  双维护漂移、无统一审计）→ 全部收敛为**单一技能层**：
  - `src/lib/skills/`（types/registry/runner/catalog/prompt/fences）——SkillDefinition 声明式
    定义 + `runSkill` 单管道（resolve→validate→gate→execute→audit）+ 18 内置技能 4 族
    （comp.* 11 参数 schema 从 COMP_TOOLS 派生同源 / bio.* 4 / web.search 1 / canvas.* 2）。
  - **门控执行层强制**：bioToolsEnabled/webSearchEnabled 从 prompt 文案升级为 runSkill 硬门
    （denied 状态 + 审计）；**prompt 清单从注册表实时渲染**——与执行门控同规则永不漂移。
  - **统一协议 ```skill fence** + 旧 ```tool/```bio/```web 围栏向后兼容归一；未知名不静默丢弃
    → invalid 信封（幻觉可见）；流式泳道慢技能拒绝 → skipped 状态（可见化）。
  - **web.search 补真**：原 webSearchEnabled 是宣传无执行的假能力，现为 z-ai-web-dev-sdk
    真实联网检索（浏览器 e2e：真模型发 ```skill → 真结果折入回复 → 审计 1.3s ok）。
  - **全链路收敛**：chat / chat-stream / workflow agent+biotool+comp 节点（审计钩子，专门
    执行器保留集群路由+auto-wire）/ PI canvas 变更（canvas.* 技能化，同不变量同审计）/ REST
    bio-tools / ToolJob 泳道 —— 全部落 SkillInvocation 审一表（source/agent/五态/时长）。
  - **观测面**：GET /api/skills（?agentId= 资格解析）+ GET /api/skills/invocations + 技能面板
    （Registry 浏览器 + Activity 审计日志，J6-a 子代理交付）。
  - 浏览器级 e2e：金路径（真模型 ```skill bio.pdb → 真 RCSB → 卡片 bio|bio.pdb|completed）+
    web.search 首执行 + done.toolCalls 即时合并修复 + Activity 双行核对 + 移动端 + console
    零警告；基线重冻与恢复纪律遵守（详见 Task 41 worklog）。
- **L 线 · 真实中止与 cancelled 语义（本轮交付，S/E 参考分支三块移植）**：并行会话合并
  （Task 22-merge）决议的三块独有改进全部落到 main 的 J 线基座上，"看得见也管得住"升级为
  **真实停止**：
  - **L1 进程注册表 + runKey 贯穿**（real-executor）：`ACTIVE_PROCS` Map + `killActiveProcess`
  （SIGTERM + 2s SIGKILL 升级 + 陈旧 unregister 防误杀后继运行）；`runKey`（= 画布节点 id）
  穿透 executeCompToolReal → native/builtin/foundry 六个 spawn 点 → runProcess 注册/注销；
  集群泳道同步改写 `triggeredBy: node:<id>`（停止路由免日志刮削直达发现）；J 线 comp 技能
  handler 也传 ctx.nodeId（agent 节点发 comp 技能同样可杀）。
  - **L2 cancelled 终态**：NodeStatus/NodeExecResult 加 `cancelled`（schema 注释同步——String
  列零迁移）；stop-registry（零依赖新模块）+ executeNodeGuarded **post-race 停止守卫**
  （迟到结果报 cancelled 而非自然结果；fresh 执行先清陈旧标志）；runner 单节点/工作流两
  泳道条件写守卫全部保留（迟到永不复活）；runner 异常安全网条件化（不再把 cancelled
  复活成 failed）；SSE 流三处终态识别 + job cancelled → node cancelled 诚实映射；runs
  路由 Recent/计数加 cancelled 泳道（queued-then-stopped 的 startedAt=null 行按
  completedAt 匹配窗口）。
  - **L3 stopNodeRun 四步真实停止**（node-run-control 新模块）：register stop →
  SIGTERM 进程 → **先行翻转 cancelled**（SSE reconcile 只动 running 行，先翻即封死竞态
  路径）→ 链接作业取消（triggeredBy 主发现 + 日志 marker 兜底，集群 scancel/
  本地 SIGTERM + 双向徽标）；响应携带 detail 溯源行（"local engine process killed" 等）。
  - **L4 async 运行模式**（run 路由 `?async=1`）：领占即返回（61ms 实测），执行后台
  fire-and-forget + 崩溃安全网条件写 failed（永不楔死 running）；RunsSheet Retry 改异步
  （spinner 只覆盖 claim 阶段）；行键盘 closest 排除清单修复（Stop/Retry 的 Enter 归
  按钮不归行）。
  - **L5 UI 三态呈现**：RunsSheet cancelled 行（Ban 图标 + zinc 药丸 + 划线 + "cancelled —
  stopped by user"）+ 汇总行含取消计数；node-card cancelled 徽章/药丸/底条 + 停止结果
  文案；minimap 状态色；inspector SSE 终态 toast 三变体；PATCH 路由状态白名单加
  cancelled。
  - **QA/e2e 证据**：API 冒烟 32/32（含 pre-spawn 守卫：claim 后立即 stop → 引擎永不
  spawn；双泳道真实击杀 pgrep 归零；迟到 9s 不复活；queued 停止 → runner 声明跳过；
  404/409 全路径）；浏览器级 e2e（真实键盘 Enter 击发 Stop 按钮 + 行不劫持 + sheet 不
  关；cancelled 徽章/划线/汇总计数 VLM 双截图实证；改轻参数后 UI 重跑 from cancelled
  真实引擎完成）；移动端 375 零溢出 + console 零错误；演示基线字段级恢复（含 16 条
  测试期 SkillInvocation 审计行清理）。
- **I 线 · RMSD 轴打磨 + 执行令牌（本轮交付，两项）**：
  - **I-1 RMSD 轴打磨（#38/#39 + rescan 提示）**：候选 DTO 新增服务端
    `pdbExists`（序列化时 existsSync）——参考选择器按磁盘存在性预检：悬空 PDB
    候选以**禁用项 + 琥珀 "file missing" 标记**呈现（不再"能选不能算"的 400
    死路）；当前参考 PDB 丢失时参考 chip 警告；H1a 抽屉叠合伙伴选择器同标准；
    rescan 新增候选缺 rmsd 键 → **琥珀补算提示**（N 个候选尚无 RMSD）；
    **域排除开关**（`Screening.rmsdExcludeRef` 持久化，PATCH 校验 boolean）：
    共享 parseDomainMetrics 把参考的 rmsd=0 锚点移出域计算（DTO 实时域与
    refreshScreeningMetrics 持久化域同源同值），其余候选归一化区间不再被常数 0
    压扁；参考行常显 **"REF" 徽标**（桌面表 + 移动卡）+ 报告披露排除状态。
    QA/浏览器证据：API 冒烟 26/26（域翻转 [0,30]→[11.9,30] / 持久化域==DTO 域 /
    非法值 400 / 悬空标记）+ 浏览器级（禁用项与标记、toggle 点击与键盘双路径、
    REF 徽标、rescan 提示、移动端 375、console 零警告）。
  - **I-6 执行令牌（#47 封口）**：`Node.runToken` 列（领占时原子写入，lane 侧生成
    ——无回读竞态）；单节点 run 路由 / 工作流 runner / SSE 集群 reconcile 的全部
    persist 守卫升级 `where status running AND runToken = 本次领占`；runner 泳道级
    crash 网移入 runNode 内并令牌化（旧的无令牌泳池网恰好是 #47 窗口本身）；
    停止不改令牌（停止凭状态赢，不凭 epoch）。**QA 证据**：冒烟 29/29——含确定性
    陈旧令牌落笔零行命中 + 修复前守卫（仅 status）会命中的反差对照、以及真 LLM
    ALPHA/BETA 双泳道竞态（旧泳道停后重试迟到落笔被隔离，终态恒为新运行的
    BETA）；集群 e2e 基础 51/51 + ceiling 76/76（含 P3 停止路径与 P5b cancelled
    映射的**陈旧断言修复**——见测试结论 #48）。浏览器级：停止（真实键盘
    Enter）→ cancelled 行/徽章/汇总 → inspector 改轻参数重跑 → 真实引擎完成
    的闭环全链路（领占令牌在 UI 流程后面隔离迟到泳道）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1-30 | （承上轮：Sweep/A/B/C/E/D/F/G 线结论与 e2e 工程标准——见 git 历史版本） | — | 已交付 |
| 31 | **P1-1 键盘所有权模式**：父容器 onKeyDown 的 preventDefault 会取消子交互元素（button/input）的原生激活——可达但死键。修复模式 = 处理器首行 `closest("button, input, [contenteditable], [role='button']")` 早退（与 pointerdown 排除清单同构，键盘侧同样需要） | 可及性 | 已修复（e2e 回归实证） |
| 32 | **P1-2 共享状态写者独立性**：liveDrag 被边存在性门控（`if (edgeDomRef.current)`）——唯一写者不应以特定消费者的存在为前提。教训泛化：**共享状态的写者与消费者解耦，写者无条件写** | 架构 | 已修复（无边场景回归实证） |
| 33 | **RMW 循环原子性模式**：逐行读-改-写 + 后置元数据 = 竞态/中断下"数据与标签分离"。修复模式 = 两阶段（纯计算零写）+ 单 `$transaction` 原子提交 + P2025→404 | 数据可信 | 已修复 |
| 34 | **Radix Select 的 "" 哨兵**：`value={x || undefined}` 的 undefined→string 切换触发 React uncontrolled→controlled 警告；Radix 明确把 "" 定义为"清空显示 placeholder"——value 全程为 string 即根除 | 代码卫生 | 已修复（console 零警告） |
| 35 | **onboarding tour 调色板按钮会真实建节点**：用正则匹配按钮文本做"dismiss"可能误中节点描述按钮（本轮自我污染源）——e2e 必须精确匹配 "Skip" 并核对节点计数 | e2e 工程标准 | 验收参考 |
| 36 | **开着的 Radix menu 全域阻断 elementFromPoint**：hit-test 断言返回 HTML——断言前必须先关菜单/Escape 清场 | e2e 工程标准 | 验收参考 |
| 37 | **拖拽失败的 pan 副作用使坐标全漂**：失败拖拽 = 背景按下 → 画布平移 → 后续测量全部过期——每次拖拽前重新测量 + "Fit to content" 恢复；坐标经文件中转防转录错误 | e2e 工程标准 | 验收参考 |
| 38 | **基线 demo screening 的 PDB 引用悬空**（预存 F4）：RMSD 轴需真实产出——服务端 400 "needs a linked PDB file on disk" 诚实报错；参考选择器只查 pdbPath 不查磁盘存在（P2-8） | UX | I 线 |
| 39 | **参考 rmsd=0 锚定域**（设计取舍）：参考参与 metricDefs 域计算（min=0 恒定）→ 其余候选归一化区间被压扁 + 参考 rmsd 轴恒满分。chip 明示 + "与参考相似度"排序语义下可辩，但可考虑把参考排除出域计算 | 科研语义 | I 线（可选项） |
| 40 | **barrel 副作用注册模式**：直接 import 子模块（skills/registry）绕过 barrel 的 `import "./catalog"` 副作用 → 注册表空、零报错静默失效。教训：**有副作用注册的中心化模块，消费方一律从 barrel 导入**；客户端安全子集（prompt/types）例外直连防服务端模块进 client bundle | 架构 | 已修复（e2e 实证 18/18） |
| 41 | **Prisma schema 变更后运行中 dev server 持旧 client**：新模型 db.x undefined → 500。既有纪律 #20 的强化实例：**db push 后必须 daemon 重启**（不依赖报错发现） | 运维 | 已遵守 |
| 42 | **流式 SSE done 事件字段丢失**：chat-stream 泳道执行的 toolCalls 只在持久化后 refetch 可见（done 处理器只 merge content/messageId）——新执行的操作卡片对用户不可见。修复：done 全字段合并 | UX | 已修复（e2e 实证卡片即时出现） |
| 43 | **模块级注册表跨热重载不自洽**：ACTIVE_PROCS 是模块内 Map——dev server 热重载产生新模块实例后，spawn 方与 kill 方可能各持一份 Map → kill 静默失败 + 孤儿引擎。教训：**含模块级单例注册表的代码改动后，QA/e2e 必须重启 dev server 再跑**（本轮孤儿引擎事故根因）；生产单实例无此问题 | 运维/QA | 已遵守（重启后 32/32） |
| 44 | **“清陈旧”防御与 async claim 的竞态**：executeNodeGuarded 开头 clearStop（清上一轮陈旧停止标志）会把 "claim 后立即 stop" 的新鲜标志一并清掉 → 引擎照常 spawn。修复 = runProcess **pre-spawn 守卫**（runKey 已停止则不 spawn）+ 停止先行翻行 + 迟到结果条件写丢弃三层兑底。教训：**新鲜度类防御需要 epoch/token，否则与异步领占竞态** | 执行语义 | 已修复（A2 用例实证） |
| 45 | **真实停止三件套模式**：①进程真实击杀（SIGTERM+SIGKILL 升级）；②**行先翻转**（reconciler/轮询只动 running 行——先翻即封死错终态竞态路径）；③条件写守卫（迟到结果永不复活）。停止顺序：register→kill→翻行→取消链接作业（作业发现走 DB triggeredBy 主路径，免日志刮） | 架构 | 已交付（L1-L3） |
| 46 | **throwaway 脚本的签名对齐**：jfetch 自定义（path, init, timeoutMs?）第 3 参数被两处调用忽略 → 默认 60s abort 误判为“服务端挂起”。教训：一次性脚本也要对齐函数签名，超时语义放 init 对象 | QA 工程 | 已修复 |
| 47 | **迟到执行 vs 重试覆盖竞态（已修复）**：stop→retry 后，旧泳道（不可杀的 LLM 长 lane）迟到 persist `where status running` 可能覆盖新运行刚领占的行。I 线修复：**领占时原子写入 lane 侧生成的 runToken，persist 守卫升级 `where status running AND runToken = 本次领占`**（SSE reconcile 同样令牌化）；QA 以确定性陈旧令牌落笔（零行命中）+ 修复前守卫反差对照 + 真 LLM ALPHA/BETA 双泳道竞态实证 | 执行语义 | 已修复（I-6） |
| 48 | **语义变更必须重跑所有断言该语义的通道（L 线事故复盘）**：L 线把停止/取消语义改为 cancelled，但未重跑集群 e2e 通道——fixture 仍断言 G 时代的 "failed" 期望，本轮跑通道才暴露 6 条陈旧断言。同批发现 sync 文件列表顺序跟随 `find`（readdir 非确定）——`files[0]` 假设是 PDB 属脆弱断言，需显式选 .pdb。教训：**改共享行为语义 → 必须全通道重跑（含测试装置自身的期望值审计）** | QA 工程 | 已修复（本轮通道全绿 51/51 + 76/76） |
| 49 | **VLM 截图前必须把目标 UI 滚入视口**：视口截图不含折叠下方内容——控件列底部的 RMSD 卡在首屏折叠下方，首轮 VLM 复核假性 FAIL；scrollIntoView 后 4/4。教训：**截图前断言目标 getBoundingClientRect 在视口内**（与 #35/#36 同族的 e2e 工程标准） | e2e 工程标准 | 验收参考 |
| 50 | **令牌/epoch 类防御的正确生成位**：领占方在写库前自生成 token（与 status=running 同一次原子写），而非写后回读——回读窗口内 stop+retry 可把新 token 读成自己的。**生成位与写入位必须同一次原子操作**（#44 "pre-spawn 守卫"模式的 DB 化） | 架构 | 已交付（I-6） |
| 51 | **对活跃上游 API 的 QA 断言必须容错**：13 连发打真 RCSB，1 次瞬时上游失败（error 行 + 诚实 502 信封）使 `oks===12` 过严断言挂掉——但限流器数学反而被更严格证明（槽位由 ok+error 共同消耗：11+1=12 → 第 13 次 429 精确）。教训：**打真实第三方 API 的计数类断言按"成功+上游错误=配额"容错，或用确定性的本地引擎通道（D5 comp 6/15min 实证）背书配额语义** | QA 工程 | 已遵守（B 阶段容错重验 13/13） |
| 52 | **用户指引文案必须指向真实可见面**：K5 queued 消息/卡片原写 "watch the Tools panel"——但本地 skill 队列 ToolJob 行在 Cluster 面板（`_meta.cluster===true` 过滤）与 AlphaFold 面板（`tool==='alphafold'` 过滤）均不可见，唯一用户可见面是 Skills Activity tab（invocation 行状态转移）。教训：**写"去哪里看"类文案前先枚举该数据经过的全部 UI 面板及其过滤条件**——否则指引一条死路 | UX/文案 | 已修复（4 处措辞 + 截图重拍） |
| 53 | **Turbopack per-route 模块图 → 同一 lib 模块多实例**：skills 注册表在 DELETE bundle 注销后，GET bundle 的目录仍 Serving 陈旧条目；globalThis once-guard 反而加剧陈旧（A bundle 的已解析 promise 让 B bundle 跳过自己的水合）。修复模式：**DB 为共享真相 + 每 bundle 实例 TTL（≤1s）同步 + 关键路径（目录读/写路由/解析失手）强制同步**——含模块级注册表的 lib 在 Turbopack dev 下不能假设单实例 | 架构 | 已修复（QA D4 实证） |
| 54 | **Prisma SQLite DateTime 的物理存储是 INTEGER epoch 毫秒**：throwaway 脚本直写 ISO 文本 → 跨类型比较静默失效（SQLite 排序中 TEXT 恒"大于"任何 INTEGER，日期比较全 false-negative 且零报错）。教训：**绕过 ORM 直改库的脚本必须按 ORM 的物理格式写**（先 `typeof(col)` 侦查）；另 bun:sqlite 的 `{readonly:false}` 触发 SQLITE_MISUSE——读写打开用无参构造 | QA 工程 | 已修复（F 相实证） |
| 55 | **干跑与实施必须共用谓词**：retention 的 estimate 与 delete 走同一 where + 同一排序（estimate 无独立代码路径）；确认对话框引用干跑刚算出的数字。教训：**"预览 N 行将被删除"类 UI 的数字来源必须就是执行路径本身**——否则预览与实施漂移成两套真相 | 架构/UX | 已交付（F6 实证 applied==promised） |
| 56 | **abort 竞态需要确定性终态判定**：webhook abort 抛错几乎瞬时（fetch reject 在微任务级），可能**跑赢**停止路由自身的 DB 行翻转——若执行器 catch 只写 "failed"，行会停在误导性 failed 而非用户要的 cancelled。修复模式：catch 里 `signal.aborted && isStopRequested(runKey)` 判定 + 执行器自己也写一次幂等 cancelled（双写条件化，先到者定终态，另一方零行命中）。教训：**"行先翻转"（#45）不是充分条件——凡 abort 类近零延迟失败路径，执行器必须自带 cancelled 判定** | 执行语义 | 已交付（N1 C1 实证） |
| 57 | **进程内 kill 注册表用 globalThis 背书（#53 的运行时版）**：模块级 Map 在 Turbopack per-route bundle 下可能多实例——spawn/abort 注册方与 kill 方各持一份则 kill 静默失败。注册数据类用 DB 共享真相（#53）；**运行时句柄类（进程/AbortController）用 globalThis 挂载 Map**——同一 JS 堆内所有 bundle 实例必然共享同一 globalThis，是句柄注册表的零成本跨 bundle 桥 | 架构 | 已交付（ACTIVE_ABORTS） |

## I 线 — RMSD 轴打磨与遗留收口（主体已交付，余项见下）

1. ~~**RMSD 轴打磨**（#38/#39）~~ **已交付**（I-1）：选择器磁盘预检（禁用项+标记）/
   rescan 补算提示 / 域排除开关 + REF 徽标 + 报告披露。余留小项：参考悬空时
   Compute 按钮的主动禁态提示（当前依赖选择器禁用项 + 服务端 400 兑底）。
2. ~~**execution token（#47）**~~ **已交付**（I-6）：领占原子写 runToken + 全
   persist 守卫令牌化 + SSE reconcile 令牌化；#47 窗口封死（QA 三重实证）。
3. **Escape 分层语义成文**（QA 38-a P2-3，未动）：pending 连线 + frame 激活时
   Escape 需两次——已知矩阵，CONTRIBUTING/验收参考记录或改为单次冒泡到全局。
4. **叠合深化遗留**（D 线延续，未动）：多链叠合选择（当前自动取对齐链）；
   per-region RMSD（CDR/loop 区段统计）；大结构 worker 对称性（H5，>5K 残基）。
5. **认证与团队协作**（NextAuth，H4 延续，未动）：工作流/campaign 共享与操作
   审计——依赖面大，建议独立分支推进。
6. **真实 SSH 集群通道**（G 线残留，未动）：F3 徽标的真实集群场景（当前 mock
   e2e 双模式 127/127 背书）。

## K 线 — Skill 层运营化（已交付：K1+K2+K3+K5；余项 K4/K6 转候选池）

- **K1 技能使用分析（已交付）**：GET /api/skills/insights（window=24h|7d|30d|all，
  非法值回退 7d）——totals（invocations/byStatus 八态并集/okRate=ok/(ok+error)/
  P50/P95/avg，**百分位只覆盖真实执行过的调用**——denied/invalid/limited/skipped
  从未进 handler，不参与测量，脚注明示）+ per-skill（calls/okRate/P50/P95/last
  used）+ per-agent（**denied/limited 信号计数**）+ per-source 泳道聚合；
  skills-panel 第三 tab "Insights"（时间窗单选 + Refresh + Outcome 分布 +
  Top skills / Most active agents / By lane 三表，45 行真实流量下 e2e 实证，
  移动端折叠布局）。
- **K2 denied 直达（已交付）**：Activity denied 行 "Fix agent access" 按钮 →
  store.pendingAgentEdit 深链（镜像 pendingScreeningId 模式）→ Agents 面板自动
  打开该 agent 的编辑对话框（知识开关触手可及）——e2e 实证（Scientific Critic
  denied 行 → 对话框打开 + 2 个知识 switch 在场）。
- **K3 速率配额（已交付）**：skills/rate-limit.ts（family 默认 comp 6/15min、
  bio 12/min、web 6/min、canvas 30/min + per-skill 覆盖 + **per-agent 滑动
  窗口**；agentId::skillId 键控）；runSkill 管道步骤 3.5（门控后执行前）；
  **槽位只被真实执行消耗**（ok/error），denied/invalid/limited 不消耗（拒绝
  不上锁）；匿名 REST/用户泳道不限流（信任级同 tools/run——滥用场景是循环
  模型不是点击的人）；"limited" 落审计表携带重试提示。配套 POST
  /api/skills/invoke（bio/web 快技能 REST 直调 + QA 面：unknown 404 invalid /
  缺参 400 / slow comp 400 指路 / canvas 400 / agent 404）。
- **K5 慢技能异步入队（已交付）**：skills/queue.ts runSkillQueued（resolve→
  validate→gate→limit→SkillInvocation "queued" 行 + ToolJob 行（triggeredBy
  agent:\<title\>）→ fire-and-forget 真引擎 runKey=jobId → 条件终写
  ok/error/cancelled）；chat 双泳道 + meeting/research/task 接入（**流式泳道
  不再拒发**：旧 skipSkill 慢技能分支废除；**门控补漏**——旧 skipSkill 从不查
  requires，bio 关闭的 agent 引擎请求会放行，现在 denied 在入队前）；workflow
  agent 节点保持同步（节点即异步底座）；崩溃网 + 服务器重启孤儿行启动清扫
  （instrumentation：queued 行诚实翻转 error/failed）；chat 卡 QUEUED 态 teal
  药丸 + 诚实快照说明（"卡片是发送时的快照，作业在后台"——模型反馈明确
  **禁止编造结果**）。
- **状态并集最终形态**：ok | error | denied | invalid | skipped | limited |
  queued | cancelled（String 列零迁移）。

**QA/e2e 证据（本线收口轮）**：API 冒烟 51/52（唯一失败 = B1a 断言对活跃
RCSB 上游过严——13 连发一次瞬时失败，限流器数学反而被更严格证明：槽位由
ok+error 共同消耗，11+1=12 → 第 13 次 429，见结论 #51）；B 阶段容错重验
13/13（12×200+1×429 确定性）；孤儿清扫实测（插伪造 queued 行 → daemon 重启
→ invocation error + ToolJob failed 诚实翻转 + dev.log 对账日志）；浏览器级
金路径全绿：Insights 聚合（45 行流量全指标 DOM 断言）/ K2 深链闭环 / K5 真
LLM → skill 围栏 → QUEUED 卡 → 真引擎完成（ToolJob completed exitCode 0 +
invocation queued→ok + 真实 PDB 工件）/ 移动端 375 零溢出 footer 贴底 /
console + page errors 零。收尾修复（P3）：queued 消息 4 处 "Tools panel"
措辞改为真实可见面 "Skills Activity tab"（本地 skill 队列行在 Cluster/
AlphaFold 面板均有过滤不可见，见结论 #52）+ 截图 39 重拍。

**余项（转候选池，测试结果驱动排序）**：
5. **动态技能注册 API**（K4）：POST /api/skills 注册自定义技能（handler 白名单
   模板或外部 webhook URL）。
6. **审计保留策略**（K6）：SkillInvocation 定期归档/清理（SQLite 体积治理）+
   筛选视图分页游标（本轮 45 行/QA 一轮即积累，真实使用会更快）。
7. **（新发现）queued 卡深链**：聊天 QUEUED 卡可加跳转 Skills 面板 Activity
   tab 的按钮（镜像 pendingAgentEdit 模式）——当前用户需手动导航。

余留候选小项（历轮累积，低优先）：Runs sheet cancelled 行无 Retry 按钮
（重跑走 inspector Run——功能可达，仅少一步直达）；"file missing" 状态可
进一步进筛选列（当前仅选择器/chip 语境）。

## 验收标准（延续并扩充）

- 每项新功能必须：API 冒烟（无效输入全 400/404/409）+ 浏览器 e2e（真实引擎、真实输出、
  文件/DB 级证据）+ undo/redo DB 一致性检查。
- **集群通道任何改动必须跑 `bun run e2e:cluster`（基础）+ 完整模式（ceiling，见
  CONTRIBUTING 集群 e2e 节）**——sweep/stop/同步/交接的语义回归由这条通道守门（#23）。
- **执行通道任何新增写点必须条件化**——已覆盖 Node.status 与 ToolJob 行写（sweep 全出口）；
  **RMW 循环类写点（逐行改 JSON 列）必须两阶段 + 单事务原子提交**（#33：值与元数据标签
  永不分离）。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**；**父容器 onKeyDown 处理
  Enter/Space/Escape 时首行必须排除子交互元素**（#31：closest 早退，否则子按钮键盘死键）；
  键盘链路 e2e 必须真实键盘事件（Tab 序 + Enter 激活 + 副作用断言）。
- **共享拖拽/订阅状态的唯一写者不得以消费者存在为前提**（#32）；订阅回调逐消费者
  try/catch。
- **e2e 选择器用完整 placeholder/测试钩子区分同类元素**；**浮动 UI（选中条/toast/menu）
  会遮挡锚点区域或全域阻断 hit-test——交互与断言前先清场**（#29/#36）；**拖拽前重新测量
  坐标（pan 副作用使旧测量过期）+ 失败后 Fit to content 恢复**（#37）。
- **Select 受控值全程同类型**（Radix "" 哨兵，#34）；**e2e 收尾必须字段级核对节点计数**
  （tour 调色板按钮会真实建节点——#35）。
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
  dev.log 无运行时错误、**console 无警告（含 React 受控切换类）**、e2e 截图 VLM 复核
  （截图前断言目标 UI 在 DOM）。
- **有副作用注册的中心化模块（如 skill 注册表）消费方一律从 barrel 导入**（#40：直连子
  模块绕过副作用 → 注册表空、零报错静默失效）；**Prisma schema 变更（db push）后必须
  daemon 重启 dev server**（#41，#20 强化）。
- **新增智能体操作路径必须走 runSkill 管道**（J 线后）：声明 SkillDefinition（含参数 schema
  + requires）→ 注册进 catalog → 不得手写旁路执行器；专门执行器（集群/队列）必须至少
  recordSkillInvocation 落审计表。
- **停止类能力的验收必须证伪"只翻行"**（L 线后）：①本地进程停止断言 pgrep 归零（真实
  SIGTERM 路径）；②迟到结果不复活（停止后 ≥ 9s 行仍 cancelled）；③行先翻转再慢速远程
  取消（reconciler 只动 running 行的竞态封死顺序，#45）；④queued 停止后 runner 声明跳过
  （claim 守卫）；⑤异步模式断言响应 <3s 且行进入 active 泳道。
- **含模块级单例注册表（ACTIVE_PROCS/STOP_REQUESTED/连接表）的代码改动后，QA/e2e 前
  必须重启 dev server**（#43：热重载产生多模块实例 → spawn 方与 kill 方各持一份 Map →
  kill 静默失败 + 孤儿引擎；重启后 32/32 复跑实证）。
- **"清陈旧"类防御必须考虑新鲜度**（#44）：先清后用模式（clearStop→执行→post-race 查）
  与异步领占竞态——新鲜停止会被当陈旧清掉；配套 pre-spawn 守卫或 epoch/token。
- **执行通道写点必须令牌化**（I 线后）：任何新的 Node 行 persist 路径一律
  `where status running AND runToken = 本次领占`（领占方在 claim 的同一次原子写里
  生成令牌，#50——写后回读有竞态）；集群 reconcile 类"读行→写行"的裁判同样带
  它读到的令牌（只落定它观察到的那次运行）。
- **改共享行为语义（停止/终态/取消类）必须重跑所有断言该语义的通道**（#48）：
  语义变更的验收清单里显式列出 `bun run e2e:cluster` 双模式与所有受影响
  fixture 的期望值审计——L 线漏跑导致 6 条陈旧断言潜伏到本轮才暴露；
  **文件列表顺序类断言不得假设 `files[0]` 的类型**（find/readdir 非确定）。
- **VLM 截图复核前必须把目标 UI 滚入视口**（#49）：截图前断言目标
  getBoundingClientRect 在视口内（视口截图不含折叠下方内容，长控件列底部
  元素首轮必假性 FAIL）。
- **含模块级注册表/单例的 lib 在 Turbopack dev 下必须按多实例设计**（#53，
  M 线后）：共享真相放 DB；读侧（目录/清单）与写侧（注册/删除）路由强制
  同步，其余消费方 TTL 同步；解析失手路径强制同步兜底——不得用 globalThis
  once-guard 假设"每进程一次"（那只是"第一个 bundle 的一次"）。
- **绕过 ORM 直改库的测试脚本先侦查物理存储格式**（#54，M 线后）：写值前
  `typeof(col)` 核对（Prisma SQLite DateTime = INTEGER epoch 毫秒）；类型
  不匹配的比较静默失效零报错——断言要对照 ORM 读回而非仅脚本自读。
- **"预览将删除/将影响 N 行"类 UI 的数字必须与执行共用同一谓词代码**（#55，
  M 线后）：dry-run 与 apply 同一函数路径（estimate 不得有独立实现），
  确认对话框引用干跑结果而非重新计算。

## M 线 — Skill 层运营深化（已交付：M1+M2+M3 全三项）

- **M1 聊天卡深链闭环（已交付）**：ToolCall 加 invocationId + 原始 skillStatus
  字段（skillCallToToolCall 双 chat 泳道同源填充；历史卡无字段优雅降级）
  → QUEUED 卡 "Watch progress"（pendingSkillTab + pendingSkillInvocation →
  Skills 面板 Tabs 转 controlled，Activity tab 加载后按 invocationId/jobId
  匹配目标行：自动展开 + 滚入视口 + 4 秒 teal 高亮环 + 未找到诚实 toast）
  → denied 卡 "Fix agent access"（pendingAgentEdit → 智能体编辑对话框，K2
  模式的聊天侧入口）→ limited 卡 "View audit row"（同 audit 深链）。
- **M2 审计保留与分页（已交付 = K6）**：SkillInvocation `@@index([createdAt])`
  （窗口查询护栏——复合索引首列非 createdAt 不命中窗口扫描）；invocations
  路由 keyset 分页（orderBy createdAt+id 双键全序去重、take limit+1 判
  hasMore、**total 恒为全量匹配数**——游标只收窄行抓取不改计数，UI "X of Y"
  与 Load more 标签不漂移）；Activity tab 过滤器（source/status Select，
  "all" 哨兵防 #34）+ Load more（游标追加，移动端 h-11 触控）；保留策略
  skills/retention.ts（AGE：终端行 >maxAgeDays 默认 90 删除；CAP：超 rowCap
  默认 20k 剪最旧终端行；**queued 行任何策略永不删**；两谓词可证不交且干跑/
  实施同代码路径——确认对话框引用干跑数字）+ instrumentation 启动清扫 +
  GET/POST /api/skills/retention（dryRun/maxAgeDays/rowCap 全校验）+
  面板 Retention 卡（干跑预览 → AlertDialog 确认 → 诚实 toast + 列表重载）。
- **M3 动态技能注册（已交付 = K4）**：Prisma CustomSkill 模型（skillId 唯一
  custom.<slug>、params JSON=SkillParamDef[]、endpoint http(s)、headers、
  enabled）+ skills/dynamic.ts（webhook handler：POST {skillId, params,
  source, agent?, at}、20s AbortSignal 超时、非 2xx/超时/网络错诚实 error、
  JSON {summary} 可塑审计行）+ **注册表同步模型**：DB 为共享真相，每 bundle
  实例 TTL ≤1s 同步 + 目录 GET/注册/删除强制同步 + runSkill 解析失手强制
  同步（Turbopack per-route 模块图多实例，见结论 #53）+ POST /api/skills
  （label/description/endpoint/params≤6/键正则/headers≤8 校验、custom. 前缀
  强制、冲突 409）+ DELETE /api/skills/[skillId]（内置 400/未知 404/审计
  历史保留）+ SkillFamily "custom"（限流 12/min + FAMILY_META + ToolCall
  kind + Webhook 图标）+ 注册对话框（表单 + 参数行编辑器）+ 每卡删除按钮
  （与展开按钮同级不嵌套）+ 提示词清单自动纳入（e2e 实证：编辑对话框的
  系统提示词预览含 custom.* 行）+ mini-services/skill-webhook（:3030
  echo/fail/slow 确定性 QA/e2e 靶）。

**QA/e2e 证据（M 线收口轮）**：API 冒烟 **42/42**（A 注册表面 13 组全 4xx
矩阵 + 201/409；B webhook 金路径 + 缺参 400 invalid + 500 error + 25s 端点
vs 20s 超时诚实超时；C custom 家族 per-agent 限流 12×200+1×429 精确 + limited
落审计；D 删除三态 + 目录驱逐 + 审计保留；E 分页全页走查 union==total +
无重复 + 坏游标 400 + 过滤 total==DB 直查真值；F retention 干跑==实施 +
回溯行删除 + queued 行保护 + 幂等二跑 0）。浏览器级金路径全绿：M3 注册
对话框 → custom 卡（endpoint 显示）→ **真 LLM 发 ```skill custom.lab-echo →
真 webhook 执行 → completed 卡 + 模型如实汇报回显**；M1 QUEUED 卡（真
rfdiffusion 排队 → Watch progress → Activity tab 直达 + 高亮行 + **后台
引擎 890ms 落地行已翻转 ok**）；M1 denied 卡（ML Engineer 发 bio.blast →
门控拒绝 → Fix agent access → 编辑对话框直达 + Bio tools 开关在场）；
M2 过滤器（api 过滤全行匹配）+ Load more（50→100 of 320）+ retention
（播种回溯行 → 干跑对话框精确数字 → 确认 → 320→319 + 列表重载）；移动端
375 零溢出 + footer 贴底 + 触控目标 44px；console/page errors 零；VLM 六
截图复核（两处首轮 FAIL 均为 #49 视口滚动假阴性，滚入视口重拍后全过）。

## N 线 — Skill 层扩展运营（已交付：N1+N2 全两项）

M 线收口后，custom 技能底座完整（注册/执行/同步/治理/深链闭环）。N 线按
测试结果驱动的价值排序：

1. **慢 webhook 技能入队**（N1）：CustomSkill.latency "slow" 的 webhook 走
   K5 队列（runSkillQueued 泳道复用，QUEUED 卡 + 真停止 + 孤儿清扫语义
   全免费继承）——长时外部计算（远端管线/批量作业）成为一等公民。M 线
   QA 已证 webhook 超时路径诚实，队列化是自然延伸。
2. **custom 技能管理面**（N2）：PATCH /api/skills/:skillId（enabled 软开关
   已在 schema、label/description/endpoint/params 编辑）+ 注册对话框复用
   为编辑对话框 + headers 字段进 UI（API 已支持）。
3. **低优先池滚动**（P2）：Runs sheet cancelled 行 Retry 直达；file-missing
   进筛选列；Escape 分层语义成文（I 线余项）；Insights 大窗口服务端聚合
   （当前 20k 行进程内聚合可接受）；叠合深化（多链/per-region）；认证与
   团队协作（独立分支）；真实 SSH 集群通道（待真实环境）。

验收标准沿用（每项：API 冒烟全 4xx 路径 + 浏览器 e2e 真实链路 + 字段级基线
恢复 + lint/tsc/dev.log/console 四清 + 结论滚动进本表）。

### N 线交付证据（2026-10-12）

- **N1 慢技能入队**：schema `CustomSkill.latency`（String 列零迁移默认
  "fast"，与重冻基线同 commit）；dynamic.ts 注册表透传 latency + 慢路径
  10 分钟超时 + `ctx.extras.webhookAbortSignal` 停止信号；queue.ts 新增
  `executeQueuedWebhookJob` 泳道（claim → pre-flight 停止守卫 → 注册
  AbortController → 同一 handler 后台执行 → 条件终写 ok/error/cancelled，
  stdout 落真实 webhook 响应快照）；real-executor `ACTIVE_ABORTS`
  （globalThis 背书）并入 `killActiveProcess`——**停止路由零改动**即真杀
  在途 fetch；invoke 路由 slow custom → 202 queued；resync 读全量行但只
  注册 enabled 行（disabled 行由目录联合投影）。
- **N2 管理面**：`skills/custom-validation.ts` 共享校验（POST/PATCH 同规
  则）；PATCH 路由七字段局部更新（空 body 400 / 内置 400 / 未知 404 /
  headers=null 清除）；GET 目录联合 disabled 行（enabled:false + eligible:
  false 投影）；面板 RegisterSkillDialog 升级为双模式 CustomSkillDialog
  （注册/编辑同表单：latency 单选卡 + headers 行编辑器 + 预填），卡片三
  按钮（Power 软开关/Pencil 编辑/Trash 删除）+ disabled/locked 药丸 +
  展开区 Endpoint/Execution/Headers。
- **QA 17/17**（/home/z/n-lane-smoke，throwaway）：A 注册投影 3（含 latency
  非法 400）+ B 队列金路径 3（202 信封/后台完成 exit 0/params 回显+headers
  透传断言/invocation ok 真实时长 ≥delay/缺参先验证 400/慢 comp 400 保留）
  + C 真实停止 1（/slow 25s 在途 → stop → cancelled + "Stopped by the
  user" + 总耗时 ≪25s 证 abort 真杀 + `_meta.executor` 归因）+ D 管理面 8
  （label/description/headers 反映、latency 切换换泳道 202、enabled=false
  不可调仍列出、恢复、params 加必填、校验矩阵 6×4xx、headers=null 清除）
  + E 限流回归 1（12+1→429 精确）+ F 清理 1。
- **E2E 浏览器级**：注册对话框（Slow 单选 + 参数行 + required）→
  custom.e2e-slow-echo 卡（slow/webhook 药丸 + 三按钮）；**真 LLM 聊天金
  路径**：```skill 围栏 → QUEUED 卡（jobId + 诚实快照 + Watch progress）→
  模型如实说"后台运行、无需进一步操作"（零编造）→ 深链直达 Activity tab
  目标行展开 → 后台 3s webhook 完成行翻转 ok（CHAT-STREAM/
  Computational Biologist/3.0s 真实时长）；编辑对话框预填 → 改描述/端点 →
  toast + 卡片更新（reload 持久化）；停用→enabled disabled+locked 药丸 +
  toast → 启用往返恢复（含一处 locked 残留修复）；移动端 375×812（
  docScrollW 375 零溢出/main 319/footer 780–812 贴底/三按钮与 Register 均
  44px）；console + page errors 零；4 截图（47/48/49/50）；VLM 复核 47 卡
  4/4、49 聊天卡 3/3、48 字段预填通过（Execution policy/Headers 在折叠下
  方——#49 视口假阴性，DOM 断言已证 radio checked）。
- **基线**：demo:fresh 重置 + outputs 清理 + daemon 重启（#41/#43 纪律）；
  字段级核对 workflows 2 / nodes 14+5 / toolJobs 16 / **skillInvocations 0
  / customSkills 0** / chatMessages 12 / screenings 3 / candidates 86。
- **过程产出**：新结论 #56（abort 竞态确定性 cancelled）、#57（globalThis
  跨 bundle kill 注册表）；#43 热重载陈旧包再次实证（多步编辑 lib 中间态
  被 Turbopack 编译缓存——重启后复验 17/17）；一处措辞残留修复（聊天卡
  "engine lands"→"run lands"，#52 同族）；E2E 中发现并修复 locked 药丸
  往返残留。

## O 线 — Skill 层授权与协同（已交付；Task 47）

N 线收口后，custom 技能已是一等公民（注册/执行/停止/编辑/停用全链路）。
测试结果暴露的排序依据：custom 技能目前 `requires: []`（注册面无授权声
明）——K2 的 denied 深链闭环对内置 bio/web 生效但 custom 全开；QUEUED 卡
为时点快照（行翻转后回看聊天仍是 queued 文案）；管理面在多人/多环境协
同下需要可移植性。三项全部落地：

1. **custom 技能授权声明（O1）✅**：CustomSkill.requires 列（JSON 闭合集
   数组，`@default("[]")` 向后兼容）+ validateRequires 共享校验（未知 id
   400 / 重复 400）+ registerCustomSkill 透传（防御性丢弃未知 id）+
   POST/PATCH/import 三面统一 + 注册/编辑对话框 "Agent knowledge
   requirements" 多选（REQUIREMENT_LABELS 渲染，UI 与门控不可漂移）+
   目录 eligible 对齐（含 disabled 行 requires 投影）。**门控与提示词
   清单零新执行代码继承**（runSkill 第 3 步 + manifest 过滤已存在——
   O1 的核心论点验证：声明式契约的收益）。QA：denied custom 403 + 错误
   文案点名 bioToolsEnabled + eligible 双向翻转 + disabled 投影。
   E2E：真 LLM 聊天点名调用 → denied 卡 + **"Fix agent access" 深链打开
   agent 编辑器正确定位知识开关**（M1 模式对 custom 生效）。
2. **QUEUED 卡活性刷新（O2）✅**：invocations 路由新增 `?ids=` 点查通道
   （≤ 50 id、忽略过滤器、无分页、空 ids 400——B 面 4 例覆盖顺序/缺 id/
   空串/过滤器旁路）；聊天抽屉在打开且有未落定 queued 卡时每 4 秒轮询，
   行翻转（ok/error/cancelled）后**卡上状态药丸原地翻转**（cancelled
   新增虚线锌药丸）+ 结果行带真实时长 + "Updated from the Activity log"
   披露 + 刷新卡保留 Watch progress 深链；**持久化 ChatMessage 永不改写**
   （refreshedAt 标记区分活状态与快照，审计诚实）；无 queued 卡即停轮询；
   打开时立即探测一次（抽屉关闭期间落地的运行即时翻转）。E2E：真 LLM
   + 真 webhook（3s delay）→ QUEUED 卡 → 4s 内翻转 completed(3.0s)。
3. **技能导入导出（O3）✅**：GET /api/skills/export?skillId= 可移植文档
   （kind "foundry-lab-skill" / version 1 / 全字段投影含 requires /
   Content-Disposition 附件 / 内置 400 / 未知 404 / 缺参 400 / 无 enabled
   泄漏）；POST /api/skills/import 信封校验（kind/version 400）+ 复用注册
   校验管道 + 冲突 409 附确定性 suggestion（custom.<base>-2/-3… 首个空闲
   id，注册表+表双源检查）+ 可选顶层 id 重命名 + 导入落 enabled=true；
   面板第四键导出按钮 + Import 按钮文件选择器 + 409 冲突确认对话框
   （"Import as …" 一键重提）。QA：**requires 跨实例可移植性**证明
   （导入副本对 critic 依然 denied）。E2E：导出 → 删除 → 导入恢复 →
   再导入 → 409 → 重命名导入（完整往返）。
4. **过程产出**：QA 58/58（A1-A8 门控矩阵 / B1-B4 点查 / C1-C11 导入导出
   矩阵 / D 清理）；E2E 6 截图（51-56）+ VLM 复核（54 刷新卡 4/4、55 移动
   端 requires 4/4）；移动端 375×812 零溢出 + footer 贴底 + 对话框 343px
   适配；console/page errors 零。

## P 线 — 下一阶段候选（基于 O 线测试结果排序）

O 线收口后，custom 技能的声明面（注册/编辑/授权/导入导出）与执行面
（队列/停止/审计/刷新）均已闭环。测试结果暴露的新排序依据：**协同可移植
性止步于单技能单文件**——多技能环境迁移是 N 手工操作；**刷新是拉模型**
（4s 轮询，多抽屉/多标签页下有重复轮询）；O1 的闭合集（2 个知识开关）
粒度粗于真实权限需求（例如"只允许特定 agent"）。按价值排序：

1. **技能集打包导出（P1）**：导出面从单技能扩展为"选中集/全量集"——
   GET /api/skills/export?ids=a,b,c（或 bundle 文档 kind
   foundry-lab-skill-bundle）+ 导入端多技能事务语义（部分失败报告，
   非全回滚）。测试面：多技能往返 + 部分冲突矩阵。
2. **推送式刷新（P2a）**：O2 拉模型升级为 SSE 广播（invocation 终态事件
   推送到打开的抽屉/Activity tab）——多客户端一致性 + 消除空轮询。
   依赖 job-events socket.io mini-service 扩展（skill-invocation 频道）。
3. **技能级 agent 白名单（P3a）**：requires 闭合集之外的第三维——
   CustomSkill.agents JSON 列（agent id 数组，空 = requires 决定），
   目录 eligible 三级解析（requires ∧ 白名单），门控第 3.25 步。
   谨慎：粒度收益 vs 管理复杂度（每技能手动维护名单）。
4. **低优先池滚动（P2）**：stop 路由 detail 措辞打磨（abort 竞态下
   "already finished" 语义可解释但欠精确）；Runs sheet cancelled 行
   Retry 直达；file-missing 筛选列；Escape 成文；Insights 服务端聚合；
   叠合深化；认证；真实集群通道。

