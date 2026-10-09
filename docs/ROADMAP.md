# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性）五轮
> 测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep 系统 + A/B/C/E 线**（详见 git 历史与 README）：参数扫描、对比视图、一键 campaign、
  组卡、DAG 并行执行、看门狗/中止/重试、undo 状态、溯源深链、演示数据治理。
- **D 线 · 科研深度（本轮交付，P1）**：
  - **D1 结构叠合比较（Superpose 3D）**：两候选/两变体的刚体叠合——序列比对（Needleman-Wunsch）
    + Horn 四元数最优拟合（复用 molecular superpose 核心），叠加视图渲染双骨架 + **逐残基偏差
    着色**（<1 Å 翠绿 / 1–2.5 Å 琥珀 / ≥2.5 Å 玫瑰 / 未匹配灰）+ 全局 RMSD 芯片 + 偏差直方图。
    两个入口：Screening Compare（恰好选 2 行）与 Sweep Compare（Superpose top 2——按得分取
    最优两个带 PDB 的完成变体）。实测：真实引擎产物叠合（88/91 对齐对、RMSD 数值合理、
    195 个着色点、直方图渲染、嵌套对话框 Esc 逐层关闭、移动端 375px 无溢出）。
  - **D2 抗体亲和力成熟链路**：`cdr_h3_length` 引擎参数（4–25 固定 H3 环长，0=按 run 采样；
    engineOnly——原生/集群 CLI 忽略并已在 hint 披露）+ 3 个 sweep 模板（CDR 编号方案 /
    **H3 长度阶梯 6/9/12/15** / 亲和力成熟库）+ "Antibody Affinity Maturation" 工作流模板
    （RFantibody → ProteinMPNN 散弹 → AlphaFold 验证 → 报告）。实测：4 变体阶梯全部真实
    引擎完成，每变体日志含 "Fixed CDR-H3 length: N"、metrics h3_len 逐变体追踪轴值、
    对比表 h3_len 列；模板链 5 节点一次 Run 全 completed（auto-wire 链路贯通）。
  - **D3 结果导出（带走结论）**：Screening **Markdown 报告**（campaign 头 + 当前权重 + 全候选
    表 + starred/shortlisted 摘要 + curated 笔记；选择语义与 CSV 一致）+ Sweep 对比表 **CSV**
    （axis + 指标 + score + file_count，无 NaN 泄漏）。实测：16 行报告含 Notes 段、
    4 行 CSV 的 h3_len 列精确等于轴值。
- **F 线 · 打磨与运维（本轮交付的子集）**：
  - **F1 失败原因可视化**：`classifyFailure`（结果标记 → stopped / watchdog / engine 三车道）
    + RunsSheet 失败行 pill + 节点卡角标（Runs API 服务端分类、512 字符前缀界、节点卡
    useMemo）。实测三车道全过：Stop→"Stopped"、坏参数引擎失败→"Engine"、3s 看门狗→"Watchdog"。
  - **F5 运维固化**：`bun run demo:fresh`（免确认重置 + 重启提醒）写入 CONTRIBUTING（含
    daemon-run.py 守护器通道与 dev server 陈旧 Prisma client 教训）。
  - **F6 提交卫生**：`db/custom.db` 移出版本控制（运行态数据每次演示都弄脏 git 树）；
    `db/demo-baseline.db` 为唯一入库事实源，fresh clone 用 `bun run demo:reset` 物化。
- **QA 修复（27-a 审查 → 27-b 闭环）**：P1×1（RunsSheet 行 onKeyDown 键盘激活被吞——并行会话
  修复在 merge 时被丢弃，本轮复活；实测 Enter 聚焦 Retry 触发重试而非画布跳转）+ P2×9
  （"?"空白链 id 回配对齐链、512 前缀分类、pill useMemo、多轴模板全匹配、tags 管道符转义、
  CSV file_count 命名、AbortController、直方图刻度按真实比例、engineOnly 边界披露）。
  审查报告全文：`qa-review-df-lane.md`。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | D1 叠合链路端到端真实数据通过（对齐/RMSD/着色/直方图/嵌套对话框/移动端） | 科研深度闭环 | 已交付 D1 |
| 2 | cdr_h3_length 参数确证贯通到引擎（日志 Fixed 行 + metrics h3_len 追踪轴值） | D2 链路可信 | 已交付 D2 |
| 3 | 模板链 5 节点一次 Run 全 completed（auto-wire pdb/fasta 贯通 + 真实引擎） | 模板可信度 | 已交付 D2 |
| 4 | 失败三车道 pill 全过（stop/engine/watchdog），API 前缀界 + 节点卡 memo | F1 可读性闭环 | 已交付 F1 |
| 5 | **陈旧 DB inode 事故**：上轮 demo:reset 后未重启 dev server（其 worklog 声称已重启）→ 服务器持有已删除 inode，SQLite "readonly database" 写失败 2 小时后才暴露。教训固化进 CONTRIBUTING + demo:fresh 提醒 | 运维 | 已闭环（F5） |
| 6 | **单节点 run 后节点卡 pill 短暂陈旧**：run POST 响应 upsertNode 与 SSE 尾包竞态，旧快照可能覆盖终态（reload 后正确；轮询因 busy=false 停止不再自愈）| 既有边界（非本轮引入） | F 线待查 |
| 7 | demo 基线 screening 候选的 PDB 文件在 outputs/ 清理后缺失——文件链接 404 是诚实降级（superpose 显示 "File not found on disk."，与 InlineResults 行为一致） | 演示体验 | D 线待办（基线重新生成或空态提示） |
| 8 | e2e 工具经验：agent-browser 鼠标坐标会被 canvas hover 重排 / footer 遮挡 / 视口外节点坑；组卡与对话框按钮用 JS click 可靠，卡片选择需物理指针 | e2e 工程标准 | 验收参考 |
| 9 | NodeSearch 跳转的 setViewport 与实际渲染 transform 偶发不一致（跳转后节点仍在视口外，需手动 pan） | 既有边界 | F 线待查 |
| 10 | 模板加载会替换当前工作流全部节点（对演示工作流有破坏风险——本轮实测把 E2E 工作流节点替换掉，靠 demo:fresh 恢复） | 模板 UX | F 线待办（确认对话框） |

## F 线 — 打磨与运维（P1，下一阶段建议）

1. **测试结论 #6/#9 两个既有竞态排查**：run 尾包 vs upsertNode 的终态覆盖（单节点 run 后
   节点卡状态短暂陈旧）；NodeSearch 跳转 viewport 变换不一致。
2. **模板加载确认对话框**（测试结论 #10）：Load template 前明确提示"将替换当前工作流的
   N 个节点"，避免演示数据被误替换。
3. **Stop/看门狗语义可视化（收尾）**：failed 行 pill 已交付；补 ToolJob 行 cancelled 与节点
   failed 的双向 badge（F3 原项）。
4. **组卡拖拽连线实时跟随**：liveDrag 机制按组 id 扩展（当前释放时重排）。
5. **手绘组持久化**：NodeGroupLayer 组信息入 DB（当前刷新丢失）。
6. **测试结论 #7**：demo 基线 PDB 缺失的空态提示（详情/叠合的 "File not found" 增加
   "outputs/ 是运行态数据——用 Rescan/重跑生成" 的引导文案）。

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
  选择必须物理指针——本轮 e2e 工程经验）。
- **执行通道任何新增写点必须条件化**（`where status="running"`）——Stop/看门狗落定不可
  复活是既定不变量。
- **demo:reset / db 变更后必须重启 dev server**（daemon-run.py 通道）——陈旧 Prisma client
  之外还有**陈旧 inode** 事故形态（SQLite readonly；本轮实测教训 #5）。
- 演示 DB 卫生：e2e 后 `bun run demo:fresh` + daemon-run.py 重启 + 字段级核对
  （14+5 节点 / 60+20+6 候选 / 无测试工作流残留）。
- 移动端 375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  e2e 截图 VLM 复核（本轮 23/24 号图过检）。
