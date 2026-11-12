# 数据接入与权限

## 接入顺序

复用项目已验证且经济口径一致的渠道。新字段优先Choice，其次东方财富妙想、Wind Market；新闻补充可用iFinD及Wind金融文档。港交所主板成交额采用官方数据。数据权限按接口与字段分别检查；单个渠道缺权限可递补到支持同口径的渠道，发生供应商切换时检查重叠期并保留记录。

本技能不附带金融服务账号。首次调用先检查宿主已连接MCP、已配置SDK、环境变量名称或系统凭据项是否存在。无需为了检测而读取全部凭据配置。密钥应通过服务官方渠道取得，并由用户在安全位置配置；使用宿主授权流程时不在聊天中收集明文。

## 连接形式

- 已连接MCP：发现工具，加载实际schema，然后调用。新增MCP通过宿主的连接／安装工具完成，不手工篡改共享配置。
- 已配置API客户端：先查看帮助与非敏感配置，只读复用。客户端路径保存在local-config，技能正文使用相对路径。
- Choice SDK：检查Python位数、SDK及DLL路径，复用现有激活。运行前确认实际Python解释器；SDK与渲染器可以使用不同解释器。使用`RecordLoginInfo=0`，不调用`c.stop()`。
- 自建API：用户提供官方文档地址、endpoint及认证方式；先核对schema，再进行小样本验证，禁止猜测请求字段。

`local-config.json`仅保存项目根、时区、客户端／SDK路径、凭据环境变量名、MCP服务别名、字段映射、历史目录、盈利篮子目录。禁止保存真实key、token、口令、含密钥URL。示例见`templates/local-config.example.json`。

## 验证表

每一类至少执行一个真实请求，并记录status、source、field、actual_start、actual_end、unit、count、missing_count及request_file。status分为verified、permission_denied、authentication_required、quota_exhausted、empty、schema_mismatch。最后四类不能标成授权已完成。核验记录在本机项目内保留，不随技能包分发。

- 行情：恒指、国企、恒科两个实际交易日的CLOSE。
- 估值：恒指PE_TTM、DIVIDEND_YIELD；检查币种与百分比尺度。
- 资金：沪深南向净额、买卖总额；海外主动基金披露的样本范围及统计日。
- 宏观：中美10年国债收益率、3个月HIBOR、美元指数及一个月度指标。
- 盈利：A股与港股各少量证券，固定目标年与历史截止日；港股原币与人民币双查。

## 已验证的Choice请求形式

在实际SDK／客户端能力确认后使用：

- 指数：`csd('HSI.HI,HSCEI.HI,HSTECH.HI','CLOSE',start,end,'Period=1,AdjustFlag=1')`。
- 南向净额：`EMM01589047,EMM01589049`，单位亿港元。
- 南向买卖：`EMI01747573,EMI01747574,EMI01747589,EMI01747590`，单位百万港元；四项之和除100为亿港元。
- HIBOR：`EMM00166394`，先`edbquery`确认3个月及单位。
- EDB：`edb(ids,'StartDate=YYYY-MM-DD,EndDate=YYYY-MM-DD')`，日期位于options。实际返回可能含多个频率的并集日期，各指标独立过滤。
- 港股EPS：`css(codes,'AVGEPS1','Year=2027,EndDate=YYYY-MM-DD,Cycle=180,CurType=1,Ispandas=0')`；人民币查询采用供应商定义的CurType参数，禁止猜值。
- A股EPS：`css(codes,'WESTEPS,WESTINSTNUM','PREDICTYEAR=2027,EndDate=YYYY-MM-DD,Cycle=180,Ispandas=0')`。

代码与ID需先验证名称、日期和单位；权限因账号而异。批量EPS每批至多100只。用量查询无数据不等于余额充足。

## 远程与官方渠道

- 妙想：发现适用品种工具，query写明名称、代码、区间、频率、单位、收益率曲线和实际已公布值。可能出现HTTP成功但正文限流、空数组；这类结果停止批量放大。
- Wind Market：先`market_search_tools`，再`market_call_tool`；实际toolName及arguments类型以发现结果为准。恒指估值已用`get_index_fundamentals`。长历史分窗口，逐段检查实际记录数。
- 港交所：历史目录`https://www.hkex.com.hk/eng/stat/smstat/mthbull/rpt_data_statistics_archive_trading_data.json`，依目录发现分年文件；2025—2029文件名为`rpt_data_statistics_archive_trading_data_2025_2029.json`。检查实际最新日期与单位。
- 近期主板日报：`https://www.hkex.com.hk/eng/stat/smstat/dayquot/dYYMMDDe.htm`，提取`Today's Turnover: (HK$)`并验证页面DATE。半日市仍计一个实际交易日；节假日无数据不前填。
- 海外主动基金：可通过`mx_finance_search_news`查券商报告披露，原文记录统计日、港股范围、主动样本、数值、单位、舍入精度与链接。先核对重叠期。检索片段不可宣称已读全文；未取得可信披露则留空。历史底表由使用者提供或授权渠道取得，技能不包含底表。

## 初始化与更新

日／周历史至少52周，月度至少24个月。首次安装需要逐渠道初始化；提供key不保证所有字段或全部历史已获授权。日常只取新增区间与重叠窗口，缓存键绑定供应商、指标、单位、参数及日期。保持旧非空记录，修订另存新版本。最新周数据缺失时保留目标日期空点，不把历史最后一点当作当前周。
