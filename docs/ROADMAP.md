# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性 + 全量
> e2e）六轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep 系统 + A/B/C/E 线**（详见 git 历史与 README）：参数扫描、对比视图、一键 campaign、
  组卡、DAG 并行执行、看门狗/中止/重试、undo 状态、溯源深链、演示数据治理。
- **D 线 · 科研深度（本轮交付，P1）**：
  - **D1 结构叠合比较（Superpose 3D）**：两候选/两变体的刚体叠合——序列比对（Needleman-Wunsch）
    + Horn 四元数最优拟合（复用 molecular superpose 核心），叠加视图渲染双骨架 + **逐残基偏差
    着色**（<1 Å 翠绿 / 1–2.5 Å 琥珀 / ≥2.5 Å 玫瑰 / 未匹配灰）+ 全局 RMSD 芯片 + 偏差直方图。
    两个入口：Screening Compare（恰好选 2 行）与 Sweep Compare（Superpose top 2——按得分取
    最优两个带 PDB 的完成变体）。
  - **D2 抗体亲和力成熟链路**：`cdr_h3_length` 引擎参数（4–25 固定 H3 环长，0=按 run 采样；
    engineOnly——原生/集群 CLI 忽略并已在 hint 披露）+ 3 个 sweep 模板（CDR 编号方案 /
    **H3 长度阶梯 6/9/12/15** / 亲和力成熟库）+ "Antibody Affinity Maturation" 工作流模板
    （RFantibody → ProteinMPNN 散弹 → AlphaFold 验证 → 报告）。
  - **D3 结果导出（带走结论）**：Screening **Markdown 报告**（campaign 头 + 当前权重 + 全候选
    表 + starred/shortlisted 摘要 + curated 笔记；选择语义与 CSV 一致）+ Sweep 对比表 **CSV**
    （axis + 指标 + score + file_count，无 NaN 泄漏）。
- **F 线 · 打磨与运维（本轮交付的子集）**：
  - **F1 失败原因可视化**：`classifyFailure`（结果标记 → stopped / watchdog / engine 三车道）
    + RunsSheet 失败行 pill + 节点卡角标（Runs API 服务端分类、512 字符前缀界、节点卡
    useMemo）。
  - **F5 运维固化**：`bun run demo:fresh`（免确认重置 + 重启提醒）写入 CONTRIBUTING（含
    daemon-run.py 守护器通道与 dev server 陈旧 Prisma client 教训）。
  - **F6 提交卫生**：`db/custom.db` 移出版本控制；`db/demo-baseline.db` 为唯一入库事实源。
- **QA 修复（27-a 审查 → 27-b 闭环）**：P1×1（RunsSheet 行 onKeyDown 键盘激活被吞——并行会话
  修复在 merge 时被丢弃，本轮复活）+ P2×9（"?"空白链 id 回配对齐链、512 前缀分类、pill
  useMemo、多轴模板全匹配、tags 管道符转义、CSV file_count 命名、AbortController、直方图刻度
  按真实比例、engineOnly 边界披露）。审查报告全文：`qa-review-df-lane.md`。
- **E2E 全量验证（Task 28，浏览器级 + 引擎级证据）**：27-a 报告 9 项建议逐项实测全过——
  superpose happy/error×3、sweep h3 阶梯（4 变体并行 + 逐变体 "Fixed CDR-H3 length: N" 引擎
  日志 + top-2 叠合 + CSV 4 行轴值精确）、模板级联（20s 全 completed + auto-wire 双链证据）、
  failure pills 三通道 + boot 孤儿 + API 字段语义、键盘 Stop/Retry 双向、嵌套 Dialog 层级、
  移动端 375px（VLM 复验零缺陷）。**过程中现场发现并修复 2 个 P1**：① New Screening 对话框
  多工作流契约缺口（`/api/workflow` 恒返回最早工作流——非首工作流的完成节点对 picker 不可见；
  改按 activeWorkflowId 取数）；② `<main>` 缺 `min-w-0`——screening 统计卡条 768px 内禀宽把
  面板撑到 834px，375px 视口被 overflow-hidden 裁剪不可达（bisect 定位；修复后移动端 Compare
  工具栏/superpose 全链路可达 + VLM 过检）。条件写回契约第四次实证（Stop 后 45s 晚到引擎结果
  仍 failed）。演示 DB 零污染（字段级核对基线）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | D1 叠合链路端到端真实数据通过（对齐/RMSD/着色/直方图/嵌套对话框/移动端/VLM 复验） | 科研深度闭环 | 已交付 D1 |
| 2 | cdr_h3_length 参数确证贯通到引擎（逐变体日志 Fixed 行 + metrics h3_len 追踪轴值 + CSV 轴列精确） | D2 链路可信 | 已交付 D2 |
| 3 | 模板链 5 节点一次 Run 全 completed（auto-wire pdb/fasta 贯通 + 真实引擎 ~20s） | 模板可信度 | 已交付 D2 |
| 4 | 失败三车道 pill 全过（stop/engine/watchdog + boot 孤儿 reconcile），API 前缀界 + 节点卡 memo；completed 行无 failureReason 字段 | F1 可读性闭环 | 已交付 F1 |
| 5 | **陈旧 DB inode 事故**：上轮 demo:reset 后未重启 dev server → SQLite "readonly database" 写失败 2 小时后才暴露。教训固化进 CONTRIBUTING + demo:fresh 提醒 | 运维 | 已闭环（F5） |
| 6 | **单节点 run 后节点卡 pill 短暂陈旧**：run POST 响应 upsertNode 与 SSE 尾包竞态，旧快照可能覆盖终态（reload 后正确；轮询因 busy=false 停止不再自愈）| 既有边界（非本轮引入） | F 线待查 |
| 7 | demo 基线 screening 候选的 PDB 文件在 outputs/ 清理后缺失——文件链接 404 是诚实降级（superpose 显示 "File not found on disk."，与 InlineResults 行为一致；本轮 e2e 又实测一遍） | 演示体验 | F 线待办（基线重新生成或空态提示） |
| 8 | e2e 工具经验（累计）：agent-browser 坐标点击会被 canvas hover 重排/footer 遮挡/视口外节点坑；**Radix 对话框 footer 按钮的坐标点击可能静默落空（坐标正确仍不触发 onClick）——必须验证副作用、DOM click() 兜底**；自定义 checkbox 是 role=checkbox 非 input[type=checkbox]；卡内交互真实指针优先 | e2e 工程标准 | 验收参考 |
| 9 | NodeSearch 跳转的 setViewport 与实际渲染 transform 偶发不一致（跳转后节点仍在视口外，需手动 pan） | 既有边界 | F 线待查 |
| 10 | **模板加载会替换当前工作流全部节点**——本轮 e2e 再次实锤（误点把演示工作流 14 节点替换成 5 节点，demo:reset 恢复）。正确 e2e 流程：先建一次性工作流再 Load template；模板按钮在卡底部、a11y 序号易错位 | 模板 UX | **F 线 P1（确认对话框）** |
| 11 | **多工作流契约缺口模式**：`/api/workflow` 恒返回最早工作流——New Screening picker 是第三个踩坑点（前有 header/pi-copilot 已绕行）；本轮修复为按 activeWorkflowId 取数，但 dashboard-panel 仍取首工作流统计（展示性不一致，未修） | 多工作流一致性 | F 线待办 |
| 12 | **移动端 flex 子项 min-width:auto 陷阱**：MAIN 缺 min-w-0 → 内禀宽内容（统计卡条 768px）把面板撑到 834px，h-dvh overflow-hidden 裁剪成"不可达区"且页面 scrollWidth 不增（假阴性）。排查法：测 main.getBoundingClientRect().width 而非 document.scrollWidth；修复模式 min-w-0 | 布局 | 已闭环（本轮修复 + 回归） |
| 13 | **sandbox 进程生存机制**：Bash 命令结束时清理进程树（setsid/nohup/disown 不够）——dev server 必须 `( setsid bash -c 'exec bun run dev' & )` subshell 孤儿化（PPID=1）才能跨命令存活；直接启动 20-50s 内静默死亡 | 运维/e2e 前置 | CONTRIBUTING 候选 |
| 14 | VLM 截图时机陷阱：Escape 关闭后截图拍到的是底层对话框——截图前必须断言目标 UI 在 DOM 中 | e2e 工程标准 | 验收参考 |

## F 线 — 打磨与运维（P1，下一阶段建议）

1. **模板加载确认对话框**（测试结论 #10，两轮实锤）：Load template 前明确提示"将替换当前
   工作流的 N 个节点"，避免演示数据被误替换。
2. **多工作流一致性收口**（#11）：dashboard-panel 统计改取激活工作流（或全局聚合+标注）；
   审计其余 `/api/workflow` 消费点（grep 清单在 worklog Task 28）。
3. **测试结论 #6/#9 两个既有竞态排查**：run 尾包 vs upsertNode 的终态覆盖；NodeSearch 跳转
   viewport 变换不一致。
4. **CONTRIBUTING 增补**（#13/#14）：dev server 跨命令存活的孤儿化启动模式（含死亡症状
   20-50s 无日志）；e2e 截图前断言目标 UI 在 DOM。
5. **Stop/看门狗语义可视化（收尾）**：failed 行 pill 已交付；补 ToolJob 行 cancelled 与节点
   failed 的双向 badge（F3 原项）。
6. **组卡拖拽连线实时跟随**：liveDrag 机制按组 id 扩展（当前释放时重排）。
7. **手绘组持久化**：NodeGroupLayer 组信息入 DB（当前刷新丢失）。
8. **测试结论 #7**：demo 基线 PDB 缺失的空态提示（"File not found" 增加 outputs/ 运行态
   数据引导文案），或用 demo:snapshot 重新冻结含产物的基线。

## D 线 — 科研深度（P2，与 F 线并行推进）

1. **叠合深化**：候选详情单卡直接发起叠合（当前需经 Compare）；叠合 swap 按钮（参考/移动
   互换）；叠合结果入 notes/screening 指标（RMSD 作为可加权指标）。
2. **认证与团队协作**（NextAuth）：工作流 / campaign 共享与操作审计（依赖面大，视进度弹性排期）。
3. **叠合的集群/本地引擎对称性**：叠合当前纯客户端；大结构（>5K 残基）考虑 worker 线程。

## 验收标准（延续并扩充）

- 每项新功能必须：API 冒烟（无效输入全 400/404/409）+ 浏览器 e2e（真实引擎、真实输出、
  文件/DB 级证据）+ undo/redo DB 一致性检查。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（setPointerCapture 会吞掉
  派生 click，JS click() 测不出——B 线教训；对话框内 shadcn 按钮可用 JS click，节点卡
  选择必须物理指针）。
- **Radix footer 按钮的坐标点击必须验证副作用**（可能静默落空——Task 28 实测；DOM click()
  兜底可接受，副作用断言不可省）。
- **执行通道任何新增写点必须条件化**（`where status="running"`）——Stop/看门狗落定不可
  复活是既定不变量（已四轮实证）。
- **demo:reset / db 变更后必须重启 dev server**（孤儿化模式）——陈旧 Prisma client 之外
  还有**陈旧 inode** 事故形态（SQLite readonly）。
- **多工作流场景必测**：任何"取节点/取统计"的新 UI 必须在非首工作流下验证（`/api/workflow`
  ≠ 激活工作流——Task 28 P1 教训 #11）。
- **移动端宽度检查用 main 宽度而非页面 scrollWidth**（overflow-hidden 裁剪造成假阴性——
  测试结论 #12）；375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底。
- 演示 DB 卫生：e2e 后字段级核对（14+5 节点 / 60+20+6 候选 / 无测试工作流残留）。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  e2e 截图 VLM 复核（截图前断言目标 UI 在 DOM——#14）。
