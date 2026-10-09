# Foundry Lab — 贡献与运维指南

> 面向在本仓库上继续开发的工程师。覆盖日常开发循环、数据库变更、
> 以及三个容易踩的运维坑（均有实测教训，见 docs/ROADMAP.md 测试结论表）。

## 日常开发循环

```bash
bun run dev     # 开发服务器（端口 3000，唯一对外端口；始终后台运行）
bun run lint    # ESLint —— 收尾前必须零告警
bunx tsc --noEmit  # 类型检查 —— src/ 必须零错误（examples/ 的预存报错不算）
bun run db:push # Prisma schema → SQLite（见下节）
```

- 生产路径只有 `/`（单页工作台）。所有后端能力都在 `src/app/api/**` 的
  route handlers 里，不要新增页面路由。
- 实时执行状态靠 3s 轮询 + SSE（节点 stream route），不引入额外中间件。

## 数据库变更（重要）

`prisma/schema.prisma` 是唯一事实源，数据库文件在 `db/custom.db`：

```bash
# 1. 编辑 prisma/schema.prisma
# 2. 推送 schema
bun run db:push
# 3. 【schema 增列/新表时】重冻演示基线 —— 见下节 ⚠️
# 4. 重启 dev server —— 见下
```

### ⚠️ db:push 之后必须重启 dev server

**症状**：`bun run db:push` 成功后，运行中的 dev server 仍持有旧版
Prisma Client —— 新字段/新模型在 API 层表现为 `Unknown argument` 之类的
PrismaClientValidationError，且报错信息会误导你去怀疑 schema 没推上去。

**根因**：Prisma Client 是在 dev server 启动时生成的，`db:push` 只更新
数据库和 `node_modules/.prisma` 文件；运行中的进程不会热加载新的
client 代码。

**修复**：重启 `bun run dev`（杀掉旧实例再起，避免双实例争抢 3000 端口）。
此坑来自实测（ROADMAP 测试结论 #7/#9），验收清单已包含该检查。

### ⚠️ schema 增列/新表必须同 commit 重冻演示基线（#20 教训）

**症状**：`bun run db:push` 只作用于 `db/custom.db`；入库的冻结基线
`db/demo-baseline.db` 仍是旧 schema。此后任何人跑 `bun run demo:reset`
得到一个**缺新列**的 custom.db —— 再生成的 Prisma client 每次查询
workflow 表都抛 `The column main.Workflow.<new> does not exist`，
全站 workflow API 500，直到人工再 push。

**修复（已固化为流程）**：schema 变更后的标准三步——
`bun run db:push` → 演示数据核对无误 → `bun scripts/reset-demo.ts
snapshot --force` 重冻基线，并跑一次 `demo:reset --force` 往返验证
（Prisma 探针查新列不报错）。**schema diff 与重冻后的
`db/demo-baseline.db` 必须同一 commit 落地。**（实测案例：F 线
`Workflow.groups` 列，QA 30-a P1-4。）

## 演示数据库

`db/custom.db` 内含演示工作流与 screening 数据（README 与教程截图引用
它们）。**该文件已 .gitignore（F6 提交卫生）**——它是运行态数据，每次
引擎演示都会弄脏 git 树；事实源是入库的冻结基线 `db/demo-baseline.db`：

```bash
bun run demo:reset   # 交互确认后：基线 → custom.db（重启 dev server）
bun run demo:fresh   # 免确认版：重置 + 打印重启提醒（e2e 收尾用）
bun run demo:snapshot # 冻结当前 custom.db 为新基线（演示数据有意的
                     # 变更时才用——记得 git add demo-baseline.db）
```

**e2e 测试后必须恢复基线**：`bun run demo:fresh` + daemon-run.py 重启
（Prisma client 需要重新加载）；随后核对节点/边计数、screening 权重
与冻结时一致。验收标准见 docs/ROADMAP.md。

```bash
# demo:fresh 之后的重启（守护器——见「已知环境限制」）：
python3 .zscripts/daemon-run.py /home/z/my-project <日志文件> \
  bash -c "cd /home/z/my-project && node_modules/.bin/next dev -p 3000 2>&1 | tee dev.log"
```

## 代码约定

- TypeScript 严格模式；`'use client'` / `'use server'` 明确标注。
- UI 用 shadcn/ui（New York 风格）+ Tailwind CSS 4；不引 indigo/blue 主色。
- 服务端 SDK（z-ai-web-dev-sdk）只在后端用，绝不进客户端包。
- 每个新 API route：无效输入一律 400（带可读错误信息），写操作考虑
  幂等/原子 claim（参考 `db.node.updateMany` 条件更新模式）。
- 节点执行相关改动必须读 `src/lib/workflow-engine.ts` 的
  `executeNodeGuarded`（看门狗 + 集群豁免语义）与
  `src/app/api/workflow/nodes/[id]/stop/route.ts`（用户中止）的注释 ——
  **执行通道任何新增写点必须条件化**（`where status="running"`）：
  Stop/看门狗落定的行不可被迟到引擎结果复活（不变量，见 ROADMAP 验收标准）。

## 集群通道 e2e（G 线，可复现）

`bun run e2e:cluster`（`scripts/e2e/cluster-lane.ts`）把集群执行通道的全部
关键承诺搬进一条可复现的命令行验收：直连/sbatch 双模式真实远程执行
（mock-cluster 是真 ssh2 SSH 服务器 + 真实 numpy 引擎）、输出同步回本地、
节点 Stop → `stopClusterJob` 单点写入（cancelled 行 + via-node-stop 徽标）
+ 远端进程真死 + sweep 终态守卫（不复活）、poll-ceiling 交接 → SSE 流
reconcile 落定（completed/cancelled 双映射）。测试自身的清理阶段会把
DB / 连接注册表 / 运行记录 / mock 文件系统恢复到跑前基线并逐项核对计数。

前置条件：

```bash
# 1) dev server（:3000，见「已知环境限制」的守护器）
# 2) mock-cluster（:3022）：
( setsid bash -c 'cd mini-services/mock-cluster && exec bun run dev' \
    > /dev/null 2>&1 < /dev/null & )

# 3) 基础验收（P0-P2/P4/P5a/P6，不需要任何环境变量）：
bun run e2e:cluster

# 4) 完整验收（加 P3 Stop 路径 + P5b cancelled 映射 + P5c co-driver 实证）：
#    先给 dev server 注入短 poll ceiling（.env.local 追加 + 守护器重启；
#    注意用 .env.local —— .env 是入库文件，写进去会把 8s ceiling 变成仓库默认）：
echo "FOUNDRY_CLUSTER_POLL_CEILING_MS=8000" >> .env.local
#    （守护器重启 dev server —— 见上节）
bun run e2e:cluster --ceiling 8000
#    测完删掉该行并再次重启，恢复默认 30min/120min ceiling。
```

注意：
- `--ceiling` 的值只是**声明**给脚本的服务器环境期望值（脚本无法读服务器
  env）；若服务器实际没带该变量，P3 会在等待 marker 时超时并以明确错误
  失败 —— 这本身就是误配置的诚实信号。
- 调试可加 `--keep`（跳过清理，保留现场）；正式验收必须让 P6 跑完。
- `scripts/e2e/` 下的脚本是**测试装置**（同 mini-services/mock-cluster），
  不属于产品代码路径；它们可以直连 Prisma / 读写 data/*.json —— 这个
  豁免只对测试装置成立，产品代码仍然只走 API。

## 已知环境限制

- 只暴露 3000 端口（Caddy 网关）；跨端口请求用 `?XTransformPort=` 查询参数。
- `bun run build` 不在沙箱环境使用（内存受限）；以 dev server + lint +
  tsc + 浏览器 e2e 作为验收。
- **重启 dev server 必须走守护器**：直接 `setsid`/`nohup` 起的进程会被沙箱
  在 ~60–90 秒内静默收割（无 OOM、无日志）。用平台守护器：
  ```bash
  python3 .zscripts/daemon-run.py /home/z/my-project <日志文件> \
    bash -c "cd /home/z/my-project && node_modules/.bin/next dev -p 3000 2>&1 | tee dev.log"
  ```
  （double-fork + reparent to init 的进程可跨会话存活；实测验证。）
  轻量替代（Task 28 实测同样跨命令存活，原理相同——subshell 立即退出使
  进程孤儿化到 init）：
  ```bash
  ( setsid bash -c 'cd /home/z/my-project && exec bun run dev' \
      > /dev/null 2>&1 < /dev/null & )
  ```
  注意 `bun run dev` 的 dev script 自带 `| tee dev.log`，故外层重定向
  /dev/null 即可；死亡症状：起来后 20–50 秒内 curl 变 000、无日志无 OOM。
- 看门狗类时长行为测试：`FOUNDRY_NODE_TIMEOUT_MS` 短超时环境变量 + 上述
  守护器重启验证触发路径，恢复正常配置后复验无误报。
- **e2e 截图前必须断言目标 UI 在 DOM**（VLM 复核的截图拍错了状态层——
  Escape 关闭上层后截图拍到的是底层对话框；Task 28 教训）。
