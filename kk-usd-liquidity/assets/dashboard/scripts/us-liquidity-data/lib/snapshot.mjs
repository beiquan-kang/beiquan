const expectedModuleIndicators = new Map([
  ['policy-treasury-rates', [
    'treasury_yield_2y',
    'treasury_yield_5y',
    'treasury_yield_10y',
    'federal_funds_target_range',
    'effr',
    'iorb',
  ]],
  ['broad-financial-conditions', [
    'ofr_fsi',
    'sp500',
    'broad_dollar',
    'tips_10y_real_yield',
    'hy_oas',
    'vix',
    'brent_crude',
  ]],
  ['secured-funding', [
    'sofr',
    'on_rrp_rate',
    'sofr_onrrp_spread',
    'tgcr',
    'sofr_volume',
  ]],
  ['bank-credit', [
    'cp_credit_spread',
    'reserve_balances',
    'small_bank_deposits',
    'small_bank_cash_ratio',
    'srf_repo_accepted',
    'discount_window_primary',
  ]],
  ['offshore-dollar', [
    'broad_dollar',
    'eurusd_spot',
    'usdjpy_spot',
    'usdcny_spot',
    'swap_line_balance',
    'fima_repo_balance',
  ]],
  ['treasury-supply', [
    'treasury_net_issuance_5d',
    'tga_balance',
    'total_public_debt_outstanding',
    'federal_government_net_worth',
  ]],
]);

const requiredIndicatorText = [
  'id',
  'name',
  'unit',
  'direction',
  'definition',
  'formula',
  'frequency',
  'sourceName',
  'sourceUrl',
  'seriesId',
  'limitation',
];

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const dailySummaryStates = new Set(['tightening', 'easing', 'mixed', 'unchanged', 'attention', 'insufficient']);
const dailySummaryModes = new Set(['candidate-vs-published', 'bootstrap-last-two', 'no-new-observations']);
const dailySummaryDirections = new Set(['tightening', 'easing', 'mixed', 'neutral', 'event']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function flattenIndicators(snapshot) {
  const indicators = new Map();
  for (const module of snapshot.modules ?? []) {
    for (const indicator of module.indicators ?? []) {
      if (!indicators.has(indicator.id)) indicators.set(indicator.id, indicator);
    }
  }
  return indicators;
}

function validateHistory(indicator, requestedDate) {
  assert(Array.isArray(indicator.history) && indicator.history.length > 0, `${indicator.id}缺少历史数据`);
  let previousDate = '';
  for (const point of indicator.history) {
    assert(isoDatePattern.test(point.date), `${indicator.id}包含无效日期`);
    assert(point.date > previousDate, `${indicator.id}历史日期未严格递增`);
    assert(point.date <= requestedDate, `${indicator.id}包含晚于输入日的观察`);
    assert(Number.isFinite(point.value), `${indicator.id}包含无效数值`);
    previousDate = point.date;
  }
  const latest = indicator.history.at(-1);
  assert(indicator.value === latest.value, `${indicator.id}最新值与历史末值不一致`);
  assert(indicator.observationDate === latest.date, `${indicator.id}观察日与历史末日不一致`);
  assert(indicator.historyStart === indicator.history[0].date, `${indicator.id}历史起点元数据不一致`);
  assert(indicator.historyEnd === latest.date, `${indicator.id}历史终点元数据不一致`);
  assert(indicator.historyCount === indicator.history.length, `${indicator.id}历史条数元数据不一致`);
}

function validateTargetRange(indicator) {
  assert(Array.isArray(indicator.rangeHistory), '联邦基金目标区间缺少上下限历史');
  assert(indicator.rangeHistory.length === indicator.history.length, '联邦基金目标区间上下限长度不一致');
  for (let index = 0; index < indicator.rangeHistory.length; index += 1) {
    const range = indicator.rangeHistory[index];
    const midpoint = indicator.history[index];
    assert(range.date === midpoint.date, `联邦基金目标区间日期不一致 ${range.date}`);
    assert(Number.isFinite(range.lower) && Number.isFinite(range.upper), `联邦基金目标区间数值无效 ${range.date}`);
    assert(range.lower <= range.upper, `联邦基金目标区间上下限倒置 ${range.date}`);
    assert(Math.abs(midpoint.value - (range.lower + range.upper) / 2) < 1e-9, `联邦基金目标区间中点错误 ${range.date}`);
  }
  const latest = indicator.rangeHistory.at(-1);
  assert(indicator.rangeLow === latest.lower && indicator.rangeHigh === latest.upper, '联邦基金目标区间最新上下限错误');
  if (indicator.policyDecision) {
    const policy = indicator.policyDecision;
    assert(/^https:\/\/www\.federalreserve\.gov\/newsevents\/pressreleases\/monetary\d{8}a1\.htm$/.test(policy.sourceUrl), '目标区间缺少官方实施公告链接');
    assert(isoDatePattern.test(policy.effectiveDate) && policy.effectiveDate <= latest.date, '目标区间尚未纳入已生效政策');
    assert(latest.lower === policy.lower && latest.upper === policy.upper, '目标区间与最新官方实施公告不一致');
    assert(typeof policy.rawEvidence === 'string' && !Number.isNaN(Date.parse(policy.fetchedAt)), '目标区间缺少公告抓取证据');
  }
}

export function validateDailySummary(summary, snapshot) {
  assert(summary && typeof summary === 'object', '美元流动性快照缺少日度摘要');
  assert(summary.schemaVersion === '1.0.0', '美元流动性日度摘要版本错误');
  assert(typeof summary.ruleVersion === 'string' && summary.ruleVersion.trim(), '日度摘要缺少规则版本');
  assert(summary.requestedDate === snapshot.meta.requestedDate, '日度摘要输入日期不一致');
  assert(!Number.isNaN(Date.parse(summary.generatedAt)), '日度摘要生成时间无效');
  assert(dailySummaryStates.has(summary.state), '日度摘要状态无效');

  assert(summary.comparison && typeof summary.comparison === 'object', '日度摘要缺少比较基准');
  assert(dailySummaryModes.has(summary.comparison.mode), '日度摘要比较模式无效');
  for (const field of ['baseRequestedDate', 'baseGeneratedAt']) {
    const value = summary.comparison[field];
    assert(value === null || typeof value === 'string', `日度摘要${field}无效`);
  }
  if (summary.comparison.baseRequestedDate !== null) {
    assert(isoDatePattern.test(summary.comparison.baseRequestedDate), '日度摘要基准日期无效');
  }
  if (summary.comparison.baseGeneratedAt !== null) {
    assert(!Number.isNaN(Date.parse(summary.comparison.baseGeneratedAt)), '日度摘要基准生成时间无效');
  }

  assert(Number.isInteger(summary.newObservationCount) && summary.newObservationCount >= 0, '日度摘要新增观察数无效');
  assert(summary.lines && typeof summary.lines === 'object', '日度摘要缺少三行文本');
  for (const field of ['conclusion', 'changes', 'data']) {
    assert(typeof summary.lines[field] === 'string' && summary.lines[field].trim(), `日度摘要缺少${field}文本`);
  }

  assert(Array.isArray(summary.selectedChanges), '日度摘要缺少入选变化');
  assert(summary.selectedChanges.length <= 3, '日度摘要关键变化超过3组');
  assert(summary.selectedChangeCount === summary.selectedChanges.length, '日度摘要入选变化计数错误');
  assert(
    Number.isInteger(summary.significantGroupCount)
      && summary.significantGroupCount >= summary.selectedChanges.length,
    '日度摘要显著变化计数错误',
  );
  const indicators = flattenIndicators(snapshot);
  const selectedGroupIds = new Set();
  const includedMandatoryEventIds = new Set();

  for (const change of summary.selectedChanges) {
    assert(typeof change.groupId === 'string' && change.groupId.trim(), '日度摘要变化组缺少ID');
    assert(!selectedGroupIds.has(change.groupId), `日度摘要变化组重复 ${change.groupId}`);
    selectedGroupIds.add(change.groupId);
    assert(dailySummaryDirections.has(change.direction), `${change.groupId}方向无效`);
    assert(typeof change.mandatory === 'boolean', `${change.groupId}强制标记无效`);
    assert(Number.isFinite(change.priority), `${change.groupId}优先级无效`);
    assert(typeof change.text === 'string' && change.text.trim(), `${change.groupId}缺少文本`);
    assert(Array.isArray(change.mandatoryEventIds), `${change.groupId}缺少强制事件引用`);
    for (const eventId of change.mandatoryEventIds) includedMandatoryEventIds.add(eventId);
    assert(Array.isArray(change.observations), `${change.groupId}缺少比较证据`);
    for (const observation of change.observations) {
      assert(indicators.has(observation.indicatorId), `${change.groupId}引用未知指标 ${observation.indicatorId}`);
      assert(isoDatePattern.test(observation.currentDate), `${change.groupId}当前观察日期无效`);
      assert(isoDatePattern.test(observation.previousDate), `${change.groupId}上一个观察日期无效`);
      assert(observation.currentDate > observation.previousDate, `${change.groupId}比较日期顺序错误`);
      assert(observation.currentDate <= summary.requestedDate, `${change.groupId}包含未来观察`);
      assert(Number.isFinite(observation.currentValue), `${change.groupId}当前观察值无效`);
      assert(Number.isFinite(observation.previousValue), `${change.groupId}上一个观察值无效`);
      assert(Number.isFinite(observation.delta), `${change.groupId}变化值无效`);
      assert(Math.abs(observation.delta - (observation.currentValue - observation.previousValue)) < 1e-6, `${change.groupId}变化值计算错误`);
      assert(typeof observation.unit === 'string' && observation.unit.trim(), `${change.groupId}比较证据缺少单位`);
      assert(Array.isArray(observation.triggerRules), `${change.groupId}比较证据缺少触发规则`);
    }
  }

  assert(Array.isArray(summary.mandatoryEvents), '日度摘要缺少强制事件审计');
  const mandatoryEventIds = new Set();
  for (const event of summary.mandatoryEvents) {
    assert(typeof event.id === 'string' && event.id.trim(), '强制事件缺少ID');
    assert(!mandatoryEventIds.has(event.id), `强制事件重复 ${event.id}`);
    mandatoryEventIds.add(event.id);
    assert(typeof event.ruleId === 'string' && event.ruleId.trim(), `${event.id}缺少规则ID`);
    assert(Array.isArray(event.indicatorIds) && event.indicatorIds.length > 0, `${event.id}缺少指标引用`);
    for (const indicatorId of event.indicatorIds) {
      assert(indicators.has(indicatorId), `${event.id}引用未知指标 ${indicatorId}`);
    }
    assert(isoDatePattern.test(event.date) && event.date <= summary.requestedDate, `${event.id}日期无效`);
    assert(typeof event.text === 'string' && event.text.trim(), `${event.id}缺少文本`);
    assert(selectedGroupIds.has(event.includedGroupId), `${event.id}未进入三组关键变化`);
    assert(includedMandatoryEventIds.has(event.id), `${event.id}未被关键变化引用`);
  }

  assert(summary.mandatoryAudit && typeof summary.mandatoryAudit === 'object', '日度摘要缺少强制事件核验');
  assert(Array.isArray(summary.mandatoryAudit.checkedRules), '日度摘要缺少强制规则清单');
  assert(summary.mandatoryAudit.detectedEventCount === summary.mandatoryEvents.length, '强制事件发现计数错误');
  assert(summary.mandatoryAudit.includedEventCount === includedMandatoryEventIds.size, '强制事件入选计数错误');
  assert(summary.mandatoryEvents.every((event) => includedMandatoryEventIds.has(event.id)), '存在未披露的强制事件');

  assert(Array.isArray(summary.omittedSignificantGroupIds), '日度摘要缺少省略变化组清单');
  const omittedGroupIds = new Set(summary.omittedSignificantGroupIds);
  assert(omittedGroupIds.size === summary.omittedSignificantGroupIds.length, '日度摘要省略变化组重复');
  assert(summary.omittedSignificantGroupIds.every((id) => typeof id === 'string' && !selectedGroupIds.has(id)), '日度摘要省略变化组无效');
  assert(
    summary.significantGroupCount === summary.selectedChanges.length + summary.omittedSignificantGroupIds.length,
    '日度摘要显著变化总数与入选、省略清单不一致',
  );

  if (summary.comparison.mode === 'no-new-observations') {
    assert(summary.newObservationCount === 0, '无新增模式仍包含新增观察');
    assert(summary.selectedChanges.length === 0, '无新增模式仍包含关键变化');
    assert(summary.mandatoryEvents.length === 0, '无新增模式仍包含强制事件');
  }

  return summary;
}

export function validateUsLiquiditySnapshot(snapshot, options = {}) {
  const requestedDate = options.expectedRequestedDate ?? snapshot?.meta?.requestedDate;
  assert(snapshot && typeof snapshot === 'object', '美元流动性快照不是对象');
  assert(snapshot.meta?.schemaVersion === '3.1.0', '美元流动性快照版本错误');
  assert(isoDatePattern.test(requestedDate ?? ''), '美元流动性快照缺少有效输入日期');
  assert(snapshot.meta.requestedDate === requestedDate, '美元流动性快照输入日期不一致');
  assert(!(snapshot.meta.refreshAudit?.regressedIndicatorIds?.length), '来源观察日期倒退，停止发布');
  assert(Array.isArray(snapshot.modules), '美元流动性快照缺少模块');
  assert(snapshot.modules.length === expectedModuleIndicators.size, '美元流动性模块数量错误');

  const moduleIds = snapshot.modules.map((module) => module.id);
  assert(
    JSON.stringify(moduleIds) === JSON.stringify([...expectedModuleIndicators.keys()]),
    '美元流动性模块顺序错误',
  );

  for (const module of snapshot.modules) {
    const expectedIds = expectedModuleIndicators.get(module.id);
    const actualIds = (module.indicators ?? []).map((indicator) => indicator.id);
    assert(JSON.stringify(actualIds) === JSON.stringify(expectedIds), `${module.id}指标顺序错误`);
    assert(typeof module.title === 'string' && module.title.trim(), `${module.id}缺少标题`);
    assert(typeof module.summary === 'string' && module.summary.trim(), `${module.id}缺少摘要`);
  }

  const indicators = flattenIndicators(snapshot);
  assert(indicators.size === 33, `美元流动性快照应包含33个独立指标，实际${indicators.size}个`);
  const missingCount = [...indicators.values()].filter((item) => item.status === 'missing').length;
  assert(snapshot.meta.usableIndicatorCount === 33 - missingCount, '美元流动性可用指标计数错误');
  assert(snapshot.meta.missingIndicatorCount === missingCount, '美元流动性缺失指标计数错误');
  assert(snapshot.meta.staleIndicatorCount === [...indicators.values()].filter((item) => item.status === 'stale').length, '美元流动性陈旧指标计数错误');

  for (const indicator of indicators.values()) {
    for (const field of requiredIndicatorText) {
      assert(typeof indicator[field] === 'string' && indicator[field].trim(), `${indicator.id}缺少${field}`);
    }
    assert(/^https:\/\//.test(indicator.sourceUrl), `${indicator.id}来源链接无效`);
    if (indicator.status === 'missing') {
      assert(indicator.value === null && indicator.observationDate === null, `${indicator.id}缺失状态不得保留数值或观察日`);
      assert(Array.isArray(indicator.history) && indicator.history.length === 0 && indicator.historyCount === 0, `${indicator.id}缺失状态不得保留历史`);
      assert(indicator.historyStart === null && indicator.historyEnd === null, `${indicator.id}缺失状态不得保留历史日期`);
      assert(typeof indicator.error === 'string' && indicator.error.trim(), `${indicator.id}缺失状态必须说明原因`);
      continue;
    }
    assert(indicator.status === 'ok' || indicator.status === 'stale', `${indicator.id}状态不可发布`);
    assert(Number.isFinite(indicator.value), `${indicator.id}最新值无效`);
    validateHistory(indicator, requestedDate);
  }

  const firstModuleIds = snapshot.modules[0].indicators.map((indicator) => indicator.id);
  assert(
    JSON.stringify(firstModuleIds) === JSON.stringify([
      'treasury_yield_2y',
      'treasury_yield_5y',
      'treasury_yield_10y',
      'federal_funds_target_range',
      'effr',
      'iorb',
    ]),
    '政策利率与美债定价指标错误',
  );

  if (indicators.get('federal_funds_target_range').status !== 'missing') validateTargetRange(indicators.get('federal_funds_target_range'));

  const brent = indicators.get('brent_crude');
  assert(brent.seriesId === 'B.IPE' && brent.unit === '美元/桶', '布伦特原油代码或单位错误');
  assert(brent.sourceSeriesId === 'EMM01588169', '布伦特原油数据源序列错误');

  const treasuryIds = snapshot.modules.at(-1).indicators.map((indicator) => indicator.id);
  for (const movedId of ['treasury_yield_2y', 'treasury_yield_5y', 'treasury_yield_10y']) {
    assert(!treasuryIds.includes(movedId), `${movedId}不应在财政模块重复展示`);
  }

  const sofr = indicators.get('sofr');
  const onRrp = indicators.get('on_rrp_rate');
  const spread = indicators.get('sofr_onrrp_spread');
  const sofrByDate = new Map(sofr.history.map((point) => [point.date, point.value]));
  const onRrpByDate = new Map(onRrp.history.map((point) => [point.date, point.value]));
  for (const point of spread.history) {
    assert(sofrByDate.has(point.date) && onRrpByDate.has(point.date), `SOFR利差缺少同日输入 ${point.date}`);
    const expected = Math.round((sofrByDate.get(point.date) - onRrpByDate.get(point.date)) * 100 * 1e6) / 1e6;
    assert(Math.abs(point.value - expected) < 1e-6, `SOFR利差计算错误 ${point.date}`);
  }

  if (options.requireDailySummary || snapshot.dailySummary !== undefined) {
    validateDailySummary(snapshot.dailySummary, snapshot);
  }

  return snapshot;
}

export function compactUsLiquiditySnapshot(snapshot, options = {}) {
  const requireDailySummary = options.requireDailySummary ?? true;
  validateUsLiquiditySnapshot(snapshot, { requireDailySummary });
  const indicators = Object.fromEntries(
    [...flattenIndicators(snapshot).entries()].map(([id, indicator]) => [id, {
      ...indicator,
      history: indicator.history.map((point) => [point.date, point.value]),
      ...(indicator.rangeHistory ? {
        rangeHistory: indicator.rangeHistory.map((point) => [point.date, point.lower, point.upper]),
      } : {}),
    }]),
  );

  return {
    meta: snapshot.meta,
    ...(snapshot.dailySummary ? { dailySummary: snapshot.dailySummary } : {}),
    modules: snapshot.modules.map((module) => ({
      id: module.id,
      title: module.title,
      summary: module.summary,
      status: module.status,
      primaryIndicatorId: module.primaryIndicatorId,
      indicatorIds: module.indicators.map((indicator) => indicator.id),
    })),
    indicators,
  };
}
