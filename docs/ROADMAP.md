# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）与 10-09（C+E 线数据可信度与执行健壮性）四轮测试结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep 系统 + A 线 Campaign 体验 + B 线画布与执行引擎**（详见 git 历史与 README）：
  参数扫描网格展开、对比视图、一键 campaign、聚合组卡、DAG 并行执行（3 车道）、
  防重叠布局、全局 Runs 队列。
- **E 线 · 执行健壮性与交互打磨（本轮交付）**：
  - **E1 执行看门狗**：`executeNodeGuarded` 以 `Promise.race` 为每个节点执行设 15 分钟上限
    （`FOUNDRY_NODE_TIMEOUT_MS` 可覆写）——引擎挂死不再楔死并行池；**集群路由节点豁免**
    （QA 发现的 P0 冲突：集群通道自带 30/120 分钟诚实轮询天花板，看门狗会误杀真实长任务）。
    实测：4s 超时下 agent 节点按时failed + 看门狗横幅；快引擎零误报；失败下游照常解锁。
  - **E4 运行中止**：`POST /api/workflow/nodes/:id/stop`（running/pending 原子翻转 failed +
    `[stop]` 日志痕迹 + 链接的集群作业 scancel/本地 SIGTERM 一并取消）；Runs 视图行级 Stop +
    Stop all。**全部执行通道（runner / 单节点 / SSE stream reconcile / stop）持久化条件化**
    ——Stop/看门狗落定后迟到结果不可复活（实测：LLM 迟到 80s+ 完成未覆盖 failed 判定）。
  - **E2 Retry 即时反馈**：fire-and-forget——toast 即时、spinner 只覆盖 claim 阶段、
    3s 轮询接管执行态呈现。
  - **E3 组卡拖拽**：聚合组卡可拖拽平移整组（世界边界整体钳制、rAF 节流、提交时读取最新
    成员行防 stale 覆盖、每成员 PATCH 批量持久化）；NodeSearch 与 NodeGroupLayer 过滤折叠
    成员；顺手修复 role=button 嵌套可聚焦后代的 a11y 问题（root 改 role=group）。
- **C 线 · 数据与可信度（本轮交付）**：
  - **C3 undo 状态语义**：nodes 创建 API 接受可选快照态（status/progress/result/logs/
    时间戳，白名单 + 钳制 + 截断），undo/redo 重建节点保留终态——实测：删除 completed
    变体后 Ctrl+Z 恢复为 completed（progress/result/sweepGroup 全保留，修复前恒为 idle）。
  - **C2 溯源深链**：promote 节点 inspector 显示来源 campaign chip（`from “X”` + Open）→
    深链切至 Screening 面板并精确选中该 campaign（`pendingScreeningId` 跨面板契约）。
  - **C5 sweep 依赖语义文档化**：Sweep 对话框内联提示 + README 依赖语义引注 + 教程 6.10 节
    （变体只继承入边；无上游源 = 独立根并行，不等源输出）。
  - **C4 运维文档**：schema 变更 / demo 重置后须重启 dev server（stale Prisma client）写入
    README 常见问题。
  - **C1 演示数据治理**：`bun run demo:snapshot` / `demo:reset`（double-fork 无关，独立
    bun 脚本 + 基线快照 db/demo-baseline.db）；README 演示基线描述对齐实际
    （14+5 节点 / 60+20+6 候选）。实测：冻结 → 污染 → 重置 → 逐字段恢复验证。
- **QA 修复（23-a 审查 → 23-b 闭环）**：P0×1（看门狗 vs 集群天花板冲突，集群豁免）+
  P1×2（stream reconcile 无条件覆盖收口；Stop 接通集群作业取消）+ P2×6（拖拽 rAF/排除
  列表/最新行提交、深链列表失败不误报、恢复 progress 归一、文档措辞与错字）。
  审查报告全文：`qa-review-ce-lane.md`。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | Stop 判定全链路不可复活（四写点条件化 + 迟到结果实测丢弃） | 执行可控性闭环 | 已交付 E4 |
| 2 | 看门狗与集群 30/120min 轮询天花板正面冲突（QA 推演发现） | 集群长任务会被误杀 | 已修复（集群豁免） |
| 3 | 自定义 setsid/nohup 进程被沙箱 ~60-90s 收割；必须走 .zscripts/daemon-run.py | 开发期重启操作 | F5（运维固化） |
| 4 | demo:reset 真实清理场景可用（冻结→污染→重置→字段级一致） | 演示可信度 | 已交付 C1 |
| 5 | 组卡拖拽连线在释放时重排（无实时跟随） | 观感打磨项 | F2 |
| 6 | RunsSheet Stop 为节点级 + 全局级（跨工作流）；无按工作流分组的中止 | 覆盖当前需求 | D 线视需求 |
| 7 | Stop 后 Node failed × 集群 ToolJob cancelled 语义割裂（提示性 badge 可补） | 可读性 | F3 |
| 8 | undo 恢复 pending 节点语义 = idle（runnable 集合含 pending，Run 即跑） | 语义可接受，已文档化 | 已闭环 |
| 9 | NodeGroupLayer 的手绘组仍为纯 UI 态（刷新丢失） | 既有边界（非本轮回归） | F4 |

## D 线 — 科研深度（P1，下一阶段建议）

1. **3D 叠合比较**：筛选详情支持两候选叠合（RMSD + 差异着色，复用 molecular/superpose
   worker）；对比视图行选两列 → 直接叠合；sweep 变体对比表同理接入。
2. **抗体亲和力成熟链路**：RFantibody → ProteinMPNN 串联 shotgunning（骨架→序列→评估
   全链路模板）+ 阶梯式 CDR 突变扫描（H3 长度/接触残基轴预设）。
3. **Sweep / 筛选结果导出**：对比表 CSV 与报告导出（复用 screening CSV 底座 + promote
   markdown 汇总），补齐"带走结论"的最后一环。
4. **认证与团队协作**（NextAuth）：工作流 / campaign 共享与操作审计（依赖面大，视前
   三项进度弹性排期）。

## F 线 — 打磨与运维（P1.5，与 D 线并行小项）

1. **Stop/看门狗语义可视化**：failed 行区分「引擎失败 / 用户中止 / 看门狗超时」三种
   pill + 节点卡角标（logs 已有痕迹，补 UI 层）。
2. **组卡拖拽连线实时跟随**：liveDrag 机制按组 id 扩展（当前释放时重排）。
3. **Node × ToolJob 状态联动提示**：stop 后 ToolJob 行 cancelled 与节点 failed 的双向
   badge。
4. **手绘组持久化**：NodeGroupLayer 组信息入 DB（当前刷新丢失）。
5. **运维固化**：daemon-run.py 启动通道写入贡献指南（自定义进程会被收割）；demo:reset
   后的重启提示已有，补 `bun run demo:reset && 重启` 一键化脚本。
6. **提交卫生**：db/custom.db 与 db/demo-baseline.db 双二进制跟踪（每次演示数据变动
   都弄脏 git 树）——评估 .gitignore + 首次 seed 生成基线的方案。

## 验收标准（延续并扩充）

- 每项新功能必须：API 冒烟（无效输入全 400/404/409）+ 浏览器 e2e（真实引擎、真实输出、
  文件/DB 级证据）+ undo/redo DB 一致性检查。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（setPointerCapture 会吞掉
  派生 click，JS click() 测不出——B 线教训，本轮组卡徽标复验通过）。
- **执行通道任何新增写点必须条件化**（`where status="running"`）——Stop/看门狗落定不可
  复活是本轮建立的不变量（QA 23-a P1 教训：stream reconcile 曾是漏网之鱼）。
- 跨工作流操作（切换 / 导入 / 恢复快照）后必须显式验证撤销栈不串图。
- 移动端 375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底
  （程序化 `scrollWidth==clientWidth` + 最外层 footer bottom==viewport 高度）。
- 看门狗类时长行为测试：用 `FOUNDRY_NODE_TIMEOUT_MS` 短超时环境变量 + daemon-run.py
  重启验证触发路径，恢复正常配置后复验无误报。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  演示 DB 与文档一致（`bun run demo:reset` 后字段级核对）。
