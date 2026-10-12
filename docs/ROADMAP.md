# Foundry Lab — Roadmap

> 下一阶段开发方向。基于 2026-10-07（B 线画布与执行引擎）与 2026-10-12（S 线 skill 标准化
> + E 线执行健壮性）两轮 QA/e2e 实测结论滚动更新，随每个阶段交付后重写。

## 本阶段成果（已完成）

- **S 线 · Agent Skill 标准化（用户架构方向：「所有 agent 操作用 skill 标准化」）**：
  - **Skill 基础设施**：`src/lib/skills/` —— 注册表（16 skills：11 compute + 4 bio +
    1 search）、统一执行器（查找 → 权限门 → 参数校验/类型收敛 → 看门狗超时 →
    DB 审计 → 规范化 LLM 反馈，永不抛错）、三协议 fence 解析（前向 `​```skill`
    + 遗留 `​```tool`/`​```bio` 归一化）。SkillInvocation 审计模型（caller 归因 ×6
    面）+ `GET /api/skills`（目录+统计）/`GET /api/skills/invocations`（审计 feed）。
  - **Agent 循环统一**：runAgentTurn 的 comp/bio 双分支删除，全部走 invokeSkill；
    系统提示词的技能文档由 registry 自动生成（单一事实来源，按 knowledge 配置门控）。
    **webSearchEnabled 首次真实生效**——`search.websearch`（z-ai SDK live 搜索）。
  - **Skills 面板**：目录（分组/门控 badge/参数表/示例/用量统计）+ 审计 feed
    （状态 pill/时长/caller/真实结果）+ 统计条（成功率真实审计计算）。
  - **实测**：LLM 自主遵循前向 ```skill 协议调用 bio.pubmed/search.websearch
    （live 执行、真实引用）；deferred compute skill 以中性状态落库（流式 lane
    不内联分钟级引擎）。
- **E 线 · 执行健壮性（B 线 ROADMAP P1.5 全部落地）**：
  - **E1 看门狗**：executeNodeGuarded（Promise.race 超时，15min 默认；cluster
    工具节点 = 轮询上限+5min 缓冲）—— 挂起引擎不再楔死 worker pool。
  - **E2 异步 Retry**：`POST /nodes/:id/run?async=1`（claim→秒回→后台执行+级联）；
    Retry 按钮不再贯穿整个节点执行（实测 0.06s 响应）。
  - **E4 真实进程级中止**：ACTIVE_PROCS 注册表贯穿全部 6 个引擎 spawn 点
    （SIGTERM→2s→SIGKILL）；集群作业 `triggeredBy="node:<id>"` 可查杀；
    `POST /nodes/:id/stop` + 卡片/RunsSheet Stop 按钮 + Stop all；
    `cancelled` 成为全链路一等状态（条件写守卫：迟到的自然结果永不覆盖用户中止）。
- **QA 修复（本轮实测/审查发现）**：stale stop 标志烧下一次运行（入口 clearStop）；
  stop vs SSE reconcile 竞态三连修（cancelled 映射/翻转提前/条件写）；deferred
  状态误标 failed；RunsSheet 键盘冒泡劫持；看门狗定时器泄漏；unknown-skill 审计；
  feedback fence 转义加固；排队即停节点从 Runs 队列消失；.gitignore 治理
  （db/agent-ctx/outputs/pid 不再入库）。
- **C5（顺手）**：sweep 对话框语义提示（变体继承入边——无上游变体立即并行执行）。

## 测试结论（驱动后续优先级）

| # | 发现 | 影响 | 对应方向 |
|---|------|------|----------|
| 1 | LLM 真实遵循 registry 生成的 ```skill 前向协议（无需 function-calling API） | fence 协议路线对任意模型可行 | 已交付 |
| 2 | webSearchEnabled 此前形同虚设——skill 化后才真实执行 | 配置可信度 | 已修复 |
| 3 | stop 的进程级击杀在本地 lane 真实生效（SIGTERM 后引擎终止、行落 cancelled） | 「看得见也管得住」闭环 | 已交付 |
| 4 | 流式 lane 的 compute skill deferred 是诚实语义（不内联分钟级引擎） | 长任务路由正确 | 已交付 |
| 5 | 工作流切换菜单对页面加载后新增/删除的工作流数据过期（需 reload） | 轻微 UX | C6 |
| 6 | 本地 kill 不杀进程组（python 多进程孙进程可能存活） | 极端情况下残留计算 | E5 |
| 7 | dev server 重启后集群 poll-ceiling 节点的 stop 只能行级（内存 run 记录丢失） | 运维边界 | E6 |
| 8 | RunsSheet「Stop all」对竞态完成行 409 汇总的措辞可再打磨 | 体验 | E7 |
| 9 | agent chat 中 skill 反馈的 fence 回声已被转义 + maxRounds 封顶 | 注入面收窄 | 已加固 |
| 10 | skill 审计 feed 无分页/筛选（agentId 参数已有，UI 未暴露） | 观测性 | C7 |

## C 线 — 数据与可信度（P1，下一阶段建议）

1. **演示数据治理**：IL-7Rα 战役整理为正式演示工作流（更新 README 界面一览与教程
   截图——截图需补 Skills 面板与 Stop 交互两张）。
2. **实验溯源（Provenance）深化**：变体 → 输出文件 → 筛选候选 → promote 节点血缘；
   SkillInvocation 审计与 promote 事件关联。
3. **undo 状态语义补齐**：create API 接受可选 status 字段。
4. **运维文档**：schema 变更后需重启 dev server；db 已 untrack——贡献指南写明
   db:push + /api/seed 恢复演示基线的步骤。
5. ~~sweep 依赖语义文档化~~ 已随 C5 交付（对话框提示）。
6. **工作流切换菜单数据过期**：切换器打开时重取工作流列表（C6，测试结论 #5）。
7. **审计 feed 增强**：agentId 筛选器 + 分页（C7，后端参数已就绪）。

## S2 线 — Skill 体系深化（P1.5，本轮新增）

1. **Workflow 工具节点 skill 化**：comptool 节点的执行 lane（executeCompTool）与
   agent skill 协议合流——同一套校验/审计/超时覆盖画布节点（当前仅 agent 层接入）。
2. **Skill 配置化**：超时/门控/启用按 agent 或全局可配（配 inspector 设置面）。
3. **Skill 测试台**：Skills 面板卡片一键「试运行」（manual caller 已支持）。
4. **更多 skill**：page_reader（SDK 已支持）、代码解释器、文件读写工具。

## E 线 — 执行健壮性收尾（P2，延续）

1. **E5 进程组击杀**：本地引擎 spawn detached + `kill(-pid)`（测试结论 #6）。
2. **E6 重启后集群 stop 重建**：从 ToolJob 行重建取消路径（测试结论 #7）。
3. **E7 Stop all 汇总打磨**：区分「已停止/已完成（竞态）」措辞（测试结论 #8）。
4. **组卡可拖拽 + NodeSearch/NodeGroupLayer 过滤折叠成员**（B 线遗留 E3）。

## D 线 — 科研深度（P2，探索性）

1. **3D 叠合比较**：两候选叠合（RMSD + 差异着色），复用 molecular/superpose。
2. **抗体亲和力成熟链路**：RFantibody → MPNN 串联 shotgunning + CDR 阶梯扫描。
3. **认证与团队协作**（NextAuth）：工作流/campaign 共享，操作审计。
4. **Sweep 结果导出**：对比表 CSV / 报告。

## 验收标准（延续本阶段做法）

- 每项新功能必须：API 冒烟（无效输入全 400）+ 浏览器 e2e（真实引擎、真实输出、
  可用文件级证据验证）+ undo/redo DB 一致性检查。
- **卡内交互元素（button/链接）必须用真实指针事件实测点击**（B 线教训：JS click()
  测不出 setPointerCapture 吞 click；本轮 Stop 按钮已按此标准实测）。
- **涉及运行状态的竞态路径必须条件写守卫**（本轮教训：stop/reconcile/迟到 lane
  三方竞态——终态只能由持有 running 行的 lane 或显式 stop 落笔）。
- 跨工作流操作（切换/导入/恢复快照）后必须显式验证撤销栈不串图。
- 移动端 375px 必查：无横向溢出、Sheet 全宽、触控目标 ≥44px。
- agent 层新能力必须走 skill 协议（registry 注册 + 统一执行器 + 审计）——不再
  接受 ad-hoc 工具分支。
- 收尾必查：`bun run lint` 零告警、`tsc --noEmit`（src/）零错误、dev.log 无运行时
  错误、演示 DB 与文档一致。
