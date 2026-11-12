# 综合投研周报

通过 `/kk-week` 调用，按最近完整交易周整理宏观、港股、A股板块复盘、A股策略和美元流动性，目标交付为单个自包含 HTML。

## 研究与展示

- 宏观：增长与需求、价格与利润、信用与财政、资金与利率、外部与汇率。
- 港股：市场表现、盈利与估值、资金流向、流动性和基本面；包括固定年度盈利修正与同日中美国债利差。
- A股板块复盘：31个申万一级行业的周度及多周期表现，并结合新闻、研报整理事实与机构观点。
- A股策略：估值、风格、盈利、流动性、周期和政策；股债收益差按同日数据精确计算。
- 美元流动性：政策利率与美债定价、广义金融条件、担保融资、信用与银行、离岸美元、财政与美债供给。

模型负责研究判断和速读写作，脚本负责精确计算与页面处理。缺失值保留缺失，旧数据保留真实日期；事实、机构观点和AI判断分别表述。页面沿用雾蓝珊瑚配色，中文楷体、英文数字Arial，兼顾桌面和窄屏。

## 交付范围与运行准备

本公开包包含五页研究规则、字段映射、数据契约、港股单页计算渲染器、四页合并器及其离线测试。

**完整五页更新需要使用者另行准备各页工程、四页 HTML 外壳和美元流动性接入实现。** 宏观、A股板块及策略的生产脚本、历史成品、美元流动性来源组件和接入脚本未随包提供。`week_report.py` 生成港股单页；`assemble_reports.py` 只接受已有四页结构，不能直接处理五页成品。

运行准备：

1. 具有文件读写、命令执行、浏览器检查能力的Agent应用，以及 Python 3.9+。附带脚本只使用Python标准库。
2. 自行取得所需金融数据权限。参考资料采用Choice、东方财富妙想、Wind及官方来源；具体字段、历史和额度需逐项验证。
3. 在项目内配置客户端、SDK、数据缓存和历史目录。可复制 [配置模板](templates/local-config.example.json)，配置文件只存非敏感项；密钥由使用者在宿主安全授权流程或本机凭据中配置。
4. 固定年度盈利修正需要自行取得冻结篮子、股数、历史EPS与汇率；相关底表未随包提供。

美元流动性的独立公开实现可参阅同仓库的 [美元流动性看板](../kk-usd-liquidity/README.md)。将其接入五页周报仍需自行完成页面适配并验收。

## 安装与调用

将整个 `kk-week/` 目录复制到应用配置的技能目录，保留所有子目录，目录名与 `SKILL.md` 的 `name` 保持一致。

Hermes使用当前配置档的 `skills/` 目录，安装后检查技能列表能否发现 `kk-week`。其他支持Agent Skills的应用按其官方导入方式安装。

```text
/kk-week 更新最近完整周的综合投研周报
/kk-week 仅更新港股页
```

## 文件与命令

- [SKILL.md](SKILL.md)：完整流程与验收要求。
- [综合流程](references/integrated-workflow.md)：各页字段、计算口径、接入要求与运行限制。
- [数据接入](references/data-access.md)：授权发现、样本请求及渠道核验。
- [港股数据契约](references/indicators.md)：指标、公式与JSON结构。
- [写作与设计](references/writing-design.md)：速读、图表、字体与浏览器验收。
- `scripts/week_report.py`：港股日期、计算和渲染。
- `scripts/assemble_reports.py`：四页HTML结构合并。
- `scripts/test_*.py`：离线回归测试，使用合成测试夹具。

从技能目录运行：

```text
python scripts/week_report.py prepare --project <项目目录>
python scripts/week_report.py compute --data <normalized.json>
python scripts/week_report.py render --data <normalized.json> --out <港股页.html>
python scripts/assemble_reports.py --shell <已有四页HTML> --out <合并HTML>
python -B -m unittest discover -s scripts -p "test_*.py" -v
```

离线测试验证附带的计算、港股渲染和四页合并。真实金融取数、五页更新和其他应用的端到端运行需在使用者环境另行验收。

本包不包含账号、密钥或真实金融数据。使用与再分发遵守各供应商授权；每次更新由使用者明确调用，历史按周保留。
