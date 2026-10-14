# QA 深度审查报告 — I 线未提交改动（Task 43-a）

审查对象：工作树 vs HEAD 的全部未提交改动（I 线：I1a 磁盘预检 / I1b rescan 提示 / I1c 参考域排除 + REF 徽章 / I2 Escape 分层）。
方法：改动文件全文精读（screening.ts 服务端三处 / types.ts / screening-panel / controls-column / screening-table / node-group / candidate-detail / compare-dialog / CONTRIBUTING）+ 对照验收标准 #31–#42 逐条核查 + 外科手术式 API 冒烟（3 真实 PDB 直插 screening，全链验证后零残留清理）+ tsc/lint。QA 过程未引入任何源代码之外的状态。

**结论先行：无 P0、无 P1。实出 2 个 P2（均为 I1a 同类陷阱残留在相邻选择器，当场修复）+ 3 条 P3 备注。API 冒烟全绿：域排除 [1.01,1.4]（参考 0 被排除）、悬空 ref POST 400、空 body 400 / 未知 refId 404、I1b 数据面（PDB+exists+无 rmsd 键 = 1）、tsc 零新增、lint 零告警。**

---

## 逐项核查（对照 #31–#42 验收标准）

| 标准 | 核查结论 |
|---|---|
| #31 键盘所有权 | 新增控件（hint 内 Recompute 按钮等）均为真实 `<button>`，无父容器 onKeyDown 劫持面（ControlsColumn 无键盘 handler）✓ |
| #32 共享状态写者 | 无新共享状态 ✓ |
| #33 RMW 原子性 | computeRmsdAxis 事务模式未动（38-a P1-3 修复保持）✓ |
| #34 Radix "" 哨兵 | Select value `rmsdRefPick \|\| rmsdRef?.id \|\| ""` 全程 string（未改）✓ |
| #40 barrel 副作用 | 无 skill 层改动 ✓ |
| #42 done 合并 | computeRmsd 客户端响应处理未动 ✓ |
| 触控目标 | 自查发现 hint 内 Recompute 按钮 h-7 → 已改 h-11 md:h-8（对齐 SelectionBar 模式）✓ |
| 信息完整性 | 自查发现全悬空时 rmsdRef chip 被条件分支吞掉 → 已移出（当前参考信息不丢失）✓ |

## P2（当场修复）

### P2-1 · I1a 同类陷阱：详情抽屉 Superpose 伙伴选择器只查 pdbPath 不查磁盘存在
- **位置**：`screening-panel.tsx` superposeOptions memo × `candidate-detail.tsx` Superpose 3D launch 按钮 disabled。
- **机理**：与 #38/P2-8 完全同构——pdbPath 是落库快照，文件删除后列仍在。基线 demo 恰是全悬空态（86/86）：抽屉会列出全部悬空伙伴、launch 只查当前候选 pdbPath → 打开的叠合对话必然内联报错。RMSD 参考选择器修了，相邻选择器漏了。
- **修复**：memo 加 `c.pdbExists` 过滤；launch disabled 加 `!candidate.pdbExists` + title 三态文案。superpose-dialog 的内联 missing-file 守卫（fetch 404 → 错误 + "File not found" 提示）保留为最后防线（防"加载后文件被删"窗口）——防御纵深成立。

### P2-2 · 同类陷阱：Compare 对话框 Superpose 门控 `!!pdbPath`
- **位置**：`compare-dialog.tsx` bothHavePdb。
- **修复**：every 加 `r.candidate.pdbExists`；title 悬空态专属文案（"A selected candidate's PDB file is no longer on disk"）。

## P3（备注，不修）

- **P3-1**：promote 的 Markdown 摘要会列出参考行的 "RMSD 0"（无 REF 注记）——CSV/报告承载原始值、UI 是注记面，属可辩护取舍；记入 ROADMAP 备注。
- **P3-2**：stats-strip 直方图中参考的 0 归一化满格（clamp 语义 = "与自身相同"）——与表格 MetricCell 一致，注释已说明。
- **P3-3**：pdbExists 是请求时快照；加载后文件被删 → 计算时服务端仍诚实 400（纵深防御）。I1b 提示语已覆盖（"alignment failed"路径同列）。

## API 冒烟证据（外科手术式，零残留）

- POST /rmsd → 200：scored 3（0 / 1.4 / 1.01），DTO 域 **[1.01, 1.4]**（参考 0 排除 ✓）、落库 metricDefs 同值（单一域语义三处一致 ✓）
- 守卫：空 body 400 ✓ / 未知 refId 404 ✓ / 删文件后悬空 ref POST 400 ✓
- I1a：删文件 → GET 详情 pdbExists=false（pdbPath 保留）✓
- I1b：追加带 PDB 无 rmsd 候选 → "PDB+exists+无 rmsd 键" 计数 = 1（客户端提示数据源）✓

## Escape 分层（I2）核查

- frame 处理器 `useAppStore.getState().pendingFrom` 为**事件时读取**（非陈旧闭包）✓
- 让位后事件冒泡：LiveWire（window listener）与 page.tsx 全局链各自幂等取消 ✓
- 优先级矩阵（pending wire > frame > inspector > node selection）已成文 CONTRIBUTING「代码约定」节 ✓
- 不可达组合排除：Radix dialog 开启时 focus 被陷阱捕获，frame 不可能同时聚焦 ✓

## e2e 必测清单（Task 44 输入）

1. 基线 demo screening（全悬空）：RMSD 区空态文案 + 计数（I1a 真实场景）
2. 真实引擎产出 screening：Compute → REF 徽章 + 域 [min>0] + 表格值 = API 值（I1c 双侧一致）
3. rescan 后新候选 → amber 提示 + Recompute 按钮真点击 → 提示消失（I1b 闭环）
4. Escape 分层：真实键盘——激活组 + 拉起 pending 连线 → 单次 Escape 连线消失且组仍选中 → 第二次 Escape 组反选（I2 回归 + 新语义）
5. H2 回归（P1-1 键盘链路不受 I2 守卫影响）+ 移动端 375 + console 零警告 + 基线零污染
