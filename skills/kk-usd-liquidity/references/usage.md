# 运行与分享

## 环境和命令

公开数据流程使用 Node.js 22 或以上版本，无 npm 依赖。Windows默认使用系统自带的 `curl.exe`，缺少curl时改用PowerShell的HTTPS连接；macOS和Linux使用 Node.js `fetch`。Windows读取已有的HTTPS代理环境变量。每个抓取进程最多同时进行6个公开请求，单次网络请求约30秒超时。美元流动性公开请求最多尝试2次。

先执行 skill 内的 `scripts/create-dashboard.mjs <输出项目目录>`，随后在生成的项目目录运行以下命令。

| 命令 | 用途 |
|---|---|
| `node scripts/update.mjs` | 按北京时间今天更新全部栏目，并构建验收 |
| `node scripts/update.mjs YYYY-MM-DD` | 指定指标检查日；议息与事件保持实时抓取口径 |
| `node scripts/build.mjs` | 校验已有正式数据并生成独立 HTML |
| `node scripts/verify.mjs` | 只读核对数据合同、内嵌数据、镜像与哈希 |

更新时使用项目级 `.update.lock`。并发运行会立即停止。如果进程异常退出留下锁，先核实锁内的PID和启动时间；确认原进程已结束后再移除这个锁文件。

## 可选 Choice 接口

需要本人具有可用的 Choice 量化 API 授权、匹配的SDK与Python环境。启用后使用SDK已有登录，凭据不写入项目。Windows使用64位SDK动态库；其他系统需使用供应商对应平台的SDK。

PowerShell 配置示例中，下列路径由接收者替换为自己机器上的真实位置。

```powershell
$env:USD_LIQUIDITY_USE_CHOICE = '1'
$env:EMQUANT_SDK_DIR = '<包含 EmQuantAPI.py 的SDK目录>'
$env:USD_LIQUIDITY_PYTHON = '<可运行SDK的Python可执行文件完整路径>'
node scripts/update.mjs
```

Python可执行文件未指定时，Windows尝试 `python`，其他系统尝试 `python3`。布伦特和利率通过独立顺序会话调用 `edb`；Choice请求按原代码最多尝试3次。原始参数与响应保存在项目内。SDK或授权失败时，其他公开栏目继续发布。

## 目录

| 路径 | 内容 |
|---|---|
| `dist/index.html` | 可单独复制和直接打开的成品 |
| `dist/publication-status.json` | 成品数据完整性与哈希 |
| `data/us-liquidity/indicator-catalog.json` | 指标定义与源序列映射 |
| `data/us-liquidity/current.json` | 完整正式指标历史与日度摘要 |
| `data/rate-data/current.json` | 可选中美利差正式数据 |
| `data/fed-expectations/current.json` | 议息概率与事件日历 |
| `data/fed-expectations/raw` | 议息与日历原始响应 |
| `outputs/us-liquidity` | 指标刷新报告、公开原始响应与失败候选 |
| `outputs/update` | 每次统一更新的正式文件备份和最终报告 |
| `data/us-liquidity/raw`、`outputs/rate-data` | 政策公告与Choice请求证据 |

## 发布与排障

核心指标先经过候选生成、摘要、校验和数据事务发布，中美利差与议息随后独立更新。栏目失败时恢复自身原文件并记录原因，最后将可用结果统一写入HTML。构建或验收失败时恢复本轮全部正式文件，原始响应和备份留作排查。

`verified_partial` 允许部分来源缺失。通过验收后仍需查看 `columns`：`core.missing` 是没有数值的指标，`core.retained` 是本轮抓取失败后沿用的指标，`rates`、`fed`、`calendar` 分别说明对应状态。`core.refreshAudit` 区分新增观察、源端暂无新增和本轮未更新。

优先读取 `outputs/update/<本次运行>/run-report.json`。如果某个公开来源暂不可用，可以稍后重新执行同一日期的统一更新。不要手动把旧观察日改成检查日。若源端字段或HTML结构改变，应先对照保存的响应修复对应解析器，再运行校验。

## 分享

分享 skill 时保留完整 `kk-usd-liquidity` 文件夹结构。接收者将其放入所用客户端的 skills 目录，或者让支持本地SKILL.md的代理直接读取该文件，然后调用 `$kk-usd-liquidity`。页面运行与取数脚本也可以直接通过 Node.js 执行。

如果只分享一次生成的看板，复制 `dist/index.html` 即可。该HTML会携带本次生成的数据；接收者需要继续更新时，应同时获得生成的项目源码，并使用自己的数据授权。
