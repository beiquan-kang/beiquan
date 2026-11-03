# 数据合同与指标映射

美元流动性合同版本为 `3.1.0`。6个模块共34次指标引用，包含33个唯一指标。广义美元指数在两个模块引用，标普500作为金融条件图的右轴对照。中美利差使用独立的利率合同。

指标名称、单位、序列、来源链接、频率、缩放因子与限制以 `assets/dashboard/data/us-liquidity/indicator-catalog.json` 为准。完整校验见 `scripts/us-liquidity-data/lib/snapshot.mjs`，派生计算见 `fetch-current.cjs`。更新项目后应在生成的项目中修改对应文件。

## 模块和来源

### 政策利率与美债定价

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| 美国2年期国债收益率 | `treasury_yield_2y` | DGS2 | % |
| 美国5年期国债收益率 | `treasury_yield_5y` | DGS5 | % |
| 美国10年期国债收益率 | `treasury_yield_10y` | DGS10 | % |
| 联邦基金目标区间 | `federal_funds_target_range` | DFEDTARL / DFEDTARU | % |
| EFFR | `effr` | EFFR | % |
| IORB | `iorb` | IORB | % |

### 广义金融条件

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| OFR金融压力指数 | `ofr_fsi` | OFR FSI | 指数点 |
| 标普500指数 | `sp500` | SP500 | 指数点 |
| 美联储名义广义美元指数 | `broad_dollar` | DTWEXBGS | 指数点 |
| 10年期TIPS实际利率 | `tips_10y_real_yield` | DFII10 | % |
| 美国高收益债OAS | `hy_oas` | BAMLH0A0HYM2 | bp |
| VIX | `vix` | VIXCLS | 指数点 |
| ICE布伦特原油 | `brent_crude` | EMM01588169 | 美元/桶 |

### 在岸担保融资

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| SOFR | `sofr` | SOFR | % |
| ON RRP报价利率 | `on_rrp_rate` | RRPONTSYOFFR | % |
| 担保隔夜融资相对政策下限的市场溢价 | `sofr_onrrp_spread` | SOFR-RRPONTSYOFFR | bp |
| TGCR | `tgcr` | TGCRRATE | % |
| SOFR成交量 | `sofr_volume` | SOFRVOL | 亿美元 |

### 在岸信用与银行

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| 商业票据信用评级利差 | `cp_credit_spread` | RIFSPPNA2P2D30NB-RIFSPPNAAD30NB | bp |
| 准备金余额 | `reserve_balances` | WRESBAL | 亿美元 |
| 小银行存款 | `small_bank_deposits` | DPSSCBW027SBOG | 亿美元 |
| 小银行现金资产占比 | `small_bank_cash_ratio` | CASSCBW027SBOG/TLASCBW027SBOG | % |
| SRF常备回购接受量 | `srf_repo_accepted` | RPONTTLD | 亿美元 |
| 贴现窗口一级信贷 | `discount_window_primary` | WLCFLPCL | 亿美元 |

### 离岸美元

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| 美联储名义广义美元指数 | `broad_dollar` | DTWEXBGS | 指数点 |
| 欧元兑美元即期汇率 | `eurusd_spot` | DEXUSEU | 美元/欧元 |
| 美元兑日元即期汇率 | `usdjpy_spot` | DEXJPUS | 日元/美元 |
| 美元兑人民币即期汇率 | `usdcny_spot` | DEXCHUS | 人民币/美元 |
| 美元央行流动性互换余额 | `swap_line_balance` | SWPT | 亿美元 |
| FIMA Repo余额 | `fima_repo_balance` | H41RESPPALGTRFNWW | 亿美元 |

### 财政与美债供给

| 指标 | 字段 | 实际源序列 | 单位 |
|---|---|---|---|
| 市场化国债5日净发行 | `treasury_net_issuance_5d` | DTS-MARKETABLE-NET-ISSUANCE-5D | 亿美元 |
| TGA日终余额 | `tga_balance` | DTS-TGA-CLOSING-BALANCE | 亿美元 |
| 美国联邦政府未偿还公共债务总额 | `total_public_debt_outstanding` | tot_pub_debt_out_amt | 亿美元 |
| 美国联邦政府净值（Z.1） | `federal_government_net_worth` | FGNETWQ027S / FL312090095.Q | 亿美元 |

## 计算与时间

- FRED通过 `https://fred.stlouisfed.org/graph/fredgraph.csv` 读取实际观察值，无需FRED API密钥。OFR使用目录内的官方CSV链接。财政数据使用Fiscal Data公开API及分页，原始请求和响应留在项目中。
- 货币金额先按指标定义统一为亿美元；原始序列可能使用百万美元、十亿美元或美元，不能直接混加。具体缩放因子以目录内的 `valueScale` 为准。
- SOFR与ON RRP报价利率的单位均为%，共同观察日的利差为 `100 ×（SOFR − ON RRP）`，单位为bp。商业票据评级利差同样按共同日期相减并换算为bp。
- 小银行现金占比为 `100 × 现金资产 ÷ 总资产`。共同日期以外的数值不填充。
- 5日国债净发行指标按源端实际出现的5个观察日滚动合计。不得把日期缺失自动补成0。
- 目标区间同时保存上下限、中点和区间历史，按实施公告生效日纳入新政策，保留官方链接及HTML证据。FRED与已生效公告冲突时该项更新不能发布。
- 中美利差为 `100 ×（美国10年期收益率 − 中国10年期收益率）`，仅使用同日有效观察。Choice序列为 `E1003234`、`E1003238`、`E1003240`、`E1002649`，依次为美国2年、10年、30年及中国10年收益率。
- 布伦特实际调用 Choice `edb(EMM01588169)`，使用连续期货日收盘价。`B.IPE`保留为品种标识。首次取近十年，后续重取约30天并合并修订；源端已删除的观察同步移除，不补空值。最多取北京时间昨日已结束的收盘。
- 检查日用于限制历史序列的观察日上界。抓取到的修订历史属于当前版本，无法据此重建过去当时已知的数据。

## 日度摘要

摘要合同为 `1.0.0`，固定包含结论、关键变化、数据三行。阈值和事件判断集中在 `scripts/us-liquidity-data/generate-summary.mjs`。首次取得数据时用最新两个观察点建立基准，后续按候选相对上一正式快照的新增观察筛选变化，最多3组。相同检查日无新观察时保留前次摘要；全空快照明确标为数据不足。

政策目标区间调整、EFFR越出区间，以及SRF、贴现窗口、美元互换和FIMA Repo从零转正属于强制事件。如果强制事件无法纳入3组摘要，停止发布并保存证据。

## 议息概率与事件

Polymarket概率使用可核验的FOMC系列和官方下一次决议时间，完整读取同一事件的结果选项。Yes代币映射必须唯一且与订单簿一致。按买卖中间价、最近成交价、来源参考报价的顺序选择并披露口径，近月历史为CLOB价格序列。

24小时与7天变化只比较同一会议、Yes代币和报价口径的本地快照。没有足够本地历史时留空；各结果报价不强行归一到100%。会议切换后重新累计变化。

美联储月历、BEA和BLS官方日历提供未来事件。美东时间转换为北京时间时处理夏令时。来源缺失或无法验证更近会议时保留缺项。分享包不携带作者机器的日历缓存。

## 发布边界

`missing`须为 `value=null`、空历史、空观察日，并有原因。`stale`保留真实数值和观察日。可用历史必须严格递增、无未来日期、全部数值有限，最新值与历史末值一致。源端日期倒退、派生公式错误及文件损坏均不可发布。

核心数据完整JSON与网页脚本成对发布；统一更新最终只生成一份内嵌数据的HTML。发布清单列明各栏目状态、缺项、沿用值、源端暂无新增及文件哈希。只读验收通过后，数据缺项仍须向用户披露。
