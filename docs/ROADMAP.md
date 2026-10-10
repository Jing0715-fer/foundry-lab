# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性）、
> 10-11（F 线 P1 打磨与运维）、10-12（G 线验证通道与生产化）、10-13（H 线科研深度与可及性
> 收口，QA 审查闭环 + 浏览器级 e2e 含真实引擎与真实键盘）、10-14（J 线智能体操作
> skill 标准化）十轮测试结论滚动更新，随每个阶段交付后重写。

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
    零告警；基线纪律遵守（schema 变更重冻 + e2e 后恢复 + 字段级核对）。

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

## I 线 — RMSD 轴打磨与遗留收口（P1，下一阶段建议）

1. **RMSD 轴打磨**（#38/#39）：参考候选选择器预检磁盘存在（标记/过滤悬空 PDB）；
   rescan 后新候选无 rmsd 键的 UI 提示（"N 个新候选尚无 RMSD，请重算"）；参考排除出域
   计算的可选项（或排序时参考行加视觉标记）。
2. **Escape 分层语义成文**（QA 38-a P2-3）：pending 连线 + frame 激活时 Escape 需两次（先
   反选组再取消连线）——已知矩阵，CONTRIBUTING/验收参考记录或改为单次冒泡到全局。
3. **叠合深化遗留**（D 线延续）：多链叠合选择（当前自动取对齐链）；per-region RMSD
   （CDR/loop 区段统计）；大结构 worker 对称性（H5，>5K 残基）。
4. **认证与团队协作**（NextAuth，H4 延续）：工作流/campaign 共享与操作审计——依赖面大，
   建议独立分支推进。
5. **真实 SSH 集群通道**（G 线残留）：F3 徽标的真实集群场景（当前 mock e2e 背书）。

## K 线 — Skill 层运营化（P2，J 线后续建议）

1. **技能使用分析**：SkillInvocation 聚合视图（按 skill/source/agent 的成功率、P50/P95
   延迟、denied/invalid 趋势）——面板 Activity Tab 已有原始流，缺聚合统计卡。
2. **智能体维度资格编辑直达**：Activity 中 denied 行一键跳转该 agent 的编辑对话框
   （知识开关就在那里）——闭环门控反馈环。
3. **技能级速率与配额**：runSkill 管道加 per-agent 简单速率限制（技能滥用防护，
   web.search 尤其）。
4. **动态技能注册 API**：POST /api/skills 注册自定义技能（handler 白名单模板或外部
   webhook URL）——当前注册表仅代码内静态注册。
5. **comp 技能在流式泳道的异步入队**：慢技能当前直接 skip，可改为入 ToolJob 队列后回
   推卡片（策略泳道统一）。
6. **审计保留策略**：SkillInvocation 定期归档/清理（SQLite 体积治理）+ 筛选视图分页游标。

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
