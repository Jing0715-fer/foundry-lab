# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-05（Sweep）、10-06（A 线 Campaign 体验）、10-07（B 线画布与
> 执行引擎）、10-09（C+E 线数据可信度与执行健壮性）、10-10（D+F 线科研深度与可读性）、
> 10-11（F 线 P1 打磨与运维 + QA 审查闭环 + 浏览器级 e2e）七轮测试结论滚动更新，随每个
> 阶段交付后重写。

## 本阶段成果（已完成）

- **Sweep 系统 + A/B/C/E/D 线**（详见 git 历史与 README）：参数扫描、对比视图、一键 campaign、
  组卡、DAG 并行执行、看门狗/中止/重试、undo 状态、溯源深链、演示数据治理、Superpose 3D、
  cdr_h3_length 亲和力成熟、报告/CSV 导出、失败三车道 pill。
- **F 线 P1 · 打磨与运维（本轮交付，七项）**：
  - **F1 模板加载确认对话框**（测试结论 #10 两轮实锤的闭环）：三个替换入口（Templates
    Load / JSON 导入 / Marketplace Install）全部在删除前弹 AlertDialog——诚实披露"将删除
    当前工作流 N 节点 M 边"并给出两条保底路径（版本快照 / 新工作流）；空工作流直载无打扰。
  - **F2 多工作流一致性收口**（#11）：Dashboard 的 Workflow Status 改从 store 的激活工作流
    取数（与画布单一数据源）+ 工作流名 Badge；sidebar seed 刷新按激活 id 不再弹回首图；
    全仓 `/api/workflow`（最早工作流）消费点审计清零（剩余均为 boot/回退语义）。
  - **F3 ToolJob cancelled 双向 badge**：`job-cancel-source` 标记模块（`[stop] cancelled via
    node stop`）+ stopClusterJob 单点写入（P2-1）+ cluster/alphafold 面板 "via node stop"
    badge + cancelled stderr 展示 + cluster-panel phase fallback 修正。
  - **F4 缺失文件空态引导**（#7）：superpose 与 InlineResults 对 "File not found on disk."
    追加 outputs/ 运行产物解释 + re-run/换候选引导；InlineResults 错误改提取 API JSON 原话。
  - **F5 组卡拖拽连线实时跟随**：liveDrag 从单节点扩展为 ids 数组（`LiveDrag {ids,dx,dy}`）；
    edge-drag-patch 共享模块（node-card 提取 + edges Map 化）；折叠组拖拽的边几何按**渲染
    空间**（聚合角）计算（P1-1——e2e 实证：拖拽中 patch 边终点=聚合 x+offset 而非成员
    raw x+offset）。
  - **F6 手绘组持久化**：Workflow.groups JSON 列 + PATCH 校验（32 组/100 ids/label 64/color
    白名单）+ 4 个 DTO 生产者带 groups + restore 语义（组随工作流行存活，不在版本快照里）；
    防抖 600ms **捕获式**持久化（P1-2：目标 workflowId/groups/剪枝基线在 schedule 时快照，
    切换工作流不误写）；hydrate 于 load/switch 强制 + 同图 refetch 在 pending 期间抑制；
    node DELETE 服务端顺带剪枝 stale nodeIds（P2-2）。
  - **F7 两个既有竞态闭环**（#6/#9）：SSE status 事件携带 rowUpdatedAt（行写时刻）+
    `setNodeStatus` 落终态水位（P1-3）+ `upsertNode`/`setNodeStatus` 双守卫（终态 +
    非终态 + 非更新时间戳 → 丢弃陈旧快照；Retry/pending 合法转换恒放行）；NodeSearch 跳转
    改双 rAF（Inspector 打开后的最终画布尺寸计算——e2e 实证精确居中）。
- **QA 闭环（30-a 审查 → 30-b 修复）**：P0×0（四大不变量保持）+ P1×4 全修（P1-1 锚点空间 /
  P1-2 跨工作流污染 / P1-3 水位 / P1-4 demo 基线 schema 漂移——重冻结 + reset 往返实测）+
  P2×5 全修（含 stopClusterJob 单点写 + applySweepBlock 终态守卫——集群 sweep 不再把
  cancelled 行写回 running）。审查报告全文：`qa-review-f-lane.md`。
- **E2E（Task 31，浏览器级 + DB 级证据）**：F1 三入口（含嵌套 Esc 层级）、F2 激活一致、
  F4 引导、F5 liveDrag 铁证、F6 建组→落库→reload→hydrate 全链路、F7 精确居中、Stop 不可
  复活第 5 次实证（45s 晚到结果仍 failed）；移动端 375 零溢出 + footer 贴底；console/page/
  dev.log 零错误；演示 DB 基线字段级核对零污染。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1-14 | （承上轮：Sweep/A/B/C/E/D 线结论与 e2e 工程标准——见 git 历史版本） | — | 已交付 |
| 15 | F1 确认框三入口实测全过：14 节点演示工作流误点被拦截（Cancel 零损失）、空工作流直载、接受路径 DB 节点全新替换（Prisma id 验证） | #10 闭环 | 已交付 F1 |
| 16 | F6 组持久化全链路（框选→Ctrl+G→落库 JSON→reload→hydrate）+ 捕获式防跨工作流误写；node DELETE 服务端剪枝 stale ids | 组层数据可信 | 已交付 F6 |
| 17 | F5 liveDrag 渲染空间锚定铁证：拖拽中 patch 边终点=聚合 x+offset（修复前会跳到成员 raw 坐标——两次可见跳变） | 画布体验 | 已交付 F5 |
| 18 | F7 #6 客户端终态水位仲裁 + #9 双 rAF 精确居中（Inspector 打开后 800 宽画布中心 880,462 精确命中）；Stop 不可复活第 5 次实证 | 竞态闭环 | 已交付 F7 |
| 19 | e2e 工程经验（新增 5 条）：agent-browser 视口默认 1280×577（拖拽前必须 elementFromPoint 断言落点）；React 18+ 批处理吞同 eval 同步派发的 input+keydown（事件序列须 setTimeout 间隔）；Ctrl+F target 为 INPUT 时被 canvas listener 拒（先 blur）；press 组合键不可靠用 dispatchEvent 兜底；sweep API body 是 {sweeps:[{key,values}]} | e2e 工程标准 | 验收参考 |
| 20 | **P1-4 demo 基线 schema 漂移陷阱**：`prisma db push` 只作用于 custom.db，冻结的 demo-baseline.db 缺新列 → `demo:reset` 后全站 workflow 查询 500 直到人工 push。本轮重冻基线 + reset 往返实测解决。教训：**schema 变更必须与重冻基线同 commit** | 运维 | 已闭环（提交纪律固化） |
| 21 | F3 via-node-stop badge 的真实场景（SSH cluster 作业取消）无法在 sandbox 复现——标记写入路径（stopClusterJob 单点写 + sweep 终态守卫）由 QA 审查背书，**待真实集群/SSH mock e2e** | 测试覆盖缺口 | 下一阶段（G 线） |
| 22 | 手绘组只有创建/删除入口——updateGroup（重命名/换色）后端+持久化已就绪但无 UI 触发点；组不进版本快照（restore 后组保持——与 sweepGroup 语义一致，文档已注明） | 组层体验 | 下一阶段（小项） |

## G 线 — 验证通道与生产化（P1，下一阶段建议）

1. **SSH mock / 真实集群 e2e 通道**（#21）：把 cluster lane 的关键承诺（via-node-stop badge、
   sweep 终态守卫、stopClusterJob 单点写、poll-ceiling reconcile）搬进可复现测试——本地
   sshd 容器或 mock-ssh 层（现有 mock-cluster 只覆盖 UI 侧）。
2. **组层 UI 完善**（#22）：组的重命名/换色 popover（updateGroup 持久化已就绪）；组框空态
   （全部成员被折叠/删除时）提示。
3. **F 线 P3 备忘清理**：getLiveDrag 零消费（删或接线防御性读取）、双 rAF 隐藏标签页边界
   （切后台跳转延迟——加 visibilitychange 兜底）、marketplace 订阅 workflow 的模态重渲染
   （改 selector 窄化）。
4. **CONTRIBUTING 增补**：schema 变更流程固化为"db push → 核对基线 → snapshot 重冻 → 同
   commit"（#20 教训成文）。

## D 线 — 科研深度（P2，与 G 线并行推进）

1. **叠合深化**：候选详情单卡直接发起叠合（当前需经 Compare）；叠合 swap 按钮（参考/移动
   互换）；叠合 RMSD 作为可加权筛选指标（写入 campaign 指标体系）。
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
  复活是既定不变量（已五轮实证）；**集群 sweep 的行写同样不得覆盖终态**（applySweepBlock
  入口守卫——本轮新增）。
- **客户端终态仲裁镜像**：晚到的 SSE/POST 快照不得把本地终态打回非终态（updatedAt/
  rowUpdatedAt 水位 + upsertNode/setNodeStatus 守卫——#6 闭环）。
- **demo:reset / db 变更后必须重启 dev server**（孤儿化模式）——陈旧 Prisma client 之外
  还有**陈旧 inode** 事故形态（SQLite readonly）；**schema 变更必须与重冻基线同 commit**
  （#20——否则 reset 后全站 500）。
- **多工作流场景必测**：任何"取节点/取统计/取组"的新 UI 必须在非首工作流下验证
  （`/api/workflow` ≠ 激活工作流——Task 28 P1 教训 #11；组持久化的目标工作流必须是
  捕获值而非触发值——Task 30 P1-2）。
- **移动端宽度检查用 main 宽度而非页面 scrollWidth**（overflow-hidden 裁剪造成假阴性——
  测试结论 #12）；375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px、footer 贴底。
- **拖拽/点击 e2e 前必须 elementFromPoint 断言落点在视口内**（agent-browser 默认视口
  1280×577——元素 rect 在视口外时 CDP 事件静默落空，Task 31 教训 #19）。
- **同一 eval 内的合成事件序列必须 setTimeout 间隔派发**（React 18+ 自动批处理会把同步
  input+keydown 合并——NodeSearch Enter 与 band-select 都踩过）。
- 演示 DB 卫生：e2e 后字段级核对（14+5 节点 / 60+20+6 候选 / 无测试工作流残留）。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时错误、
  e2e 截图 VLM 复核（截图前断言目标 UI 在 DOM——#14）。
