import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flattenIndicators,
  validateUsLiquiditySnapshot,
} from './lib/snapshot.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const args = process.argv.slice(2);
const bootstrap = args.includes('--bootstrap-last-two');
const positional = args.filter((argument) => argument !== '--bootstrap-last-two');

if (positional.length !== 1 || args.length !== positional.length + Number(bootstrap)) {
  throw new Error('用法 node generate-summary.mjs YYYY-MM-DD [--bootstrap-last-two]');
}

const requestedDate = positional[0];
const parsedDate = new Date(`${requestedDate}T00:00:00Z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
  || Number.isNaN(parsedDate.getTime())
  || parsedDate.toISOString().slice(0, 10) !== requestedDate) {
  throw new Error(`摘要日期无效 ${requestedDate}`);
}

const candidatePath = path.resolve(
  process.env.US_LIQUIDITY_CANDIDATE_PATH
    || path.join(repoRoot, 'data', 'us-liquidity', 'candidate.json'),
);
const basePath = path.resolve(
  process.env.US_LIQUIDITY_BASE_PATH
    || path.join(repoRoot, 'data', 'us-liquidity', 'current.json'),
);

const groupDefinitions = [
  {
    id: 'policy-treasury-rates',
    title: '政策利率与美债定价',
    indicatorIds: [
      'treasury_yield_2y',
      'treasury_yield_5y',
      'treasury_yield_10y',
      'federal_funds_target_range',
      'effr',
      'iorb',
    ],
  },
  {
    id: 'broad-financial-conditions',
    title: '广义金融条件',
    indicatorIds: ['ofr_fsi', 'sp500', 'broad_dollar', 'tips_10y_real_yield', 'hy_oas', 'vix', 'brent_crude'],
  },
  {
    id: 'secured-funding',
    title: '在岸担保融资',
    indicatorIds: ['sofr', 'on_rrp_rate', 'sofr_onrrp_spread', 'tgcr', 'sofr_volume'],
  },
  {
    id: 'bank-credit',
    title: '在岸信用与银行',
    indicatorIds: [
      'cp_credit_spread',
      'reserve_balances',
      'small_bank_deposits',
      'small_bank_cash_ratio',
      'srf_repo_accepted',
      'discount_window_primary',
    ],
  },
  {
    id: 'offshore-dollar',
    title: '离岸美元',
    indicatorIds: [
      'broad_dollar',
      'eurusd_spot',
      'usdjpy_spot',
      'usdcny_spot',
      'swap_line_balance',
      'fima_repo_balance',
    ],
  },
  {
    id: 'treasury-supply',
    title: '财政现金与国债供给',
    indicatorIds: [
      'treasury_net_issuance_5d',
      'tga_balance',
      'total_public_debt_outstanding',
      'federal_government_net_worth',
    ],
  },
];

const rules = new Map([
  ['treasury_yield_2y', absoluteRule(0.05, 1, '5bp阈值')],
  ['treasury_yield_5y', absoluteRule(0.05, 1, '5bp阈值')],
  ['treasury_yield_10y', absoluteRule(0.05, 1, '5bp阈值')],
  ['federal_funds_target_range', absoluteRule(0.000001, 0, '政策目标调整')],
  ['ofr_fsi', absoluteRule(0.25, 1, '0.25指数点阈值')],
  ['sp500', percentRule(0.01, -1, '1%阈值')],
  ['broad_dollar', percentRule(0.0075, 1, '0.75%阈值')],
  ['tips_10y_real_yield', absoluteRule(0.05, 1, '5bp阈值')],
  ['hy_oas', absoluteRule(3, 1, '3bp阈值')],
  ['vix', combinedRule(1.5, 0.1, 1, '1.5点或10%阈值')],
  ['sofr_onrrp_spread', absoluteRule(3, 1, '3bp阈值')],
  ['tgcr', absoluteRule(0.03, 1, '3bp阈值')],
  ['sofr_volume', absoluteRule(1000, 0, '1000亿美元阈值')],
  ['cp_credit_spread', absoluteRule(3, 1, '3bp阈值')],
  ['reserve_balances', absoluteRule(500, -1, '500亿美元阈值')],
  ['small_bank_deposits', absoluteRule(500, -1, '500亿美元阈值')],
  ['small_bank_cash_ratio', absoluteRule(0.2, -1, '0.2个百分点阈值')],
  ['eurusd_spot', percentRule(0.0075, -1, '0.75%阈值')],
  ['usdjpy_spot', percentRule(0.0075, 1, '0.75%阈值')],
  ['usdcny_spot', percentRule(0.0075, 1, '0.75%阈值')],
  ['treasury_net_issuance_5d', absoluteRule(200, 1, '200亿美元阈值')],
  ['tga_balance', absoluteRule(500, 1, '500亿美元阈值')],
]);

const mandatoryRuleIds = [
  'target-range-change',
  'effr-outside-target-range',
  'srf-zero-to-positive',
  'discount-window-zero-to-positive',
  'swap-line-zero-to-positive',
  'fima-zero-to-positive',
];

const groupPriorityWeights = new Map([
  ['policy-treasury-rates', 0.5],
  ['secured-funding', 0.3],
  ['treasury-supply', 0.2],
  ['broad-financial-conditions', 0.1],
  ['offshore-dollar', 0.05],
  ['bank-credit', 0],
]);

function absoluteRule(threshold, directionSign, label) {
  return {
    directionSign,
    label,
    evaluate(observation) {
      return {
        significant: Math.abs(observation.delta) >= threshold - 1e-12,
        score: Math.abs(observation.delta) / threshold,
      };
    },
  };
}

function percentRule(threshold, directionSign, label) {
  return {
    directionSign,
    label,
    evaluate(observation) {
      const ratio = observation.previousValue === 0
        ? 0
        : Math.abs(observation.delta / observation.previousValue);
      return { significant: ratio >= threshold, score: ratio / threshold };
    },
  };
}

function combinedRule(absoluteThreshold, percentThreshold, directionSign, label) {
  return {
    directionSign,
    label,
    evaluate(observation) {
      const absoluteScore = Math.abs(observation.delta) / absoluteThreshold;
      const percentScore = observation.previousValue === 0
        ? 0
        : Math.abs(observation.delta / observation.previousValue) / percentThreshold;
      const score = Math.max(absoluteScore, percentScore);
      return { significant: score >= 1, score };
    },
  };
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function numberText(value, digits = 2) {
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function fixedText(value, digits = 2) {
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function directionFor(observation, rule) {
  if (!rule || rule.directionSign === 0 || observation.delta === 0) return 'neutral';
  return observation.delta * rule.directionSign > 0 ? 'tightening' : 'easing';
}

function makeObservation(indicator, current, previous) {
  return {
    indicatorId: indicator.id,
    currentDate: current.date,
    currentValue: current.value,
    previousDate: previous.date,
    previousValue: previous.value,
    delta: round(current.value - previous.value),
    unit: indicator.unit,
    triggerRules: [],
  };
}

function buildComparisons(candidateIndicators, baseIndicators, useBootstrap) {
  const comparisons = new Map();
  let newObservationCount = 0;

  for (const [id, indicator] of candidateIndicators) {
    const history = indicator.history;
    if (useBootstrap) {
      if (history.length < 2) continue;
      comparisons.set(id, makeObservation(indicator, history.at(-1), history.at(-2)));
      newObservationCount += 1;
      continue;
    }

    const baseIndicator = baseIndicators.get(id);
    if (!baseIndicator?.history?.length) {
      // 新恢复的序列没有可比旧值，只记录新增观察，不制造变化幅度。
      newObservationCount += history.length;
      continue;
    }
    const previous = baseIndicator.history.at(-1);
    const newPoints = history.filter((point) => point.date > previous.date);
    newObservationCount += newPoints.length;
    if (!newPoints.length) continue;
    comparisons.set(id, makeObservation(indicator, newPoints.at(-1), previous));
  }

  return { comparisons, newObservationCount };
}

function latestTargetRangeAt(indicator, date) {
  return indicator.rangeHistory?.filter((point) => point.date <= date).at(-1) || null;
}

function createMandatoryEvents(comparisons, indicators) {
  const events = [];
  const policyEvidence = comparisons.get('federal_funds_target_range') || comparisons.get('effr');
  const targetChange = comparisons.get('federal_funds_target_range');
  if (targetChange && Math.abs(targetChange.delta) > 1e-12) {
    const target = latestTargetRangeAt(indicators.get('federal_funds_target_range'), targetChange.currentDate);
    events.push({
      id: `target-range-change-${targetChange.currentDate}`,
      ruleId: 'target-range-change',
      indicatorIds: ['federal_funds_target_range'],
      date: targetChange.currentDate,
      text: target
        ? `联邦基金目标区间调整至${fixedText(target.lower)}%至${fixedText(target.upper)}%`
        : '联邦基金目标区间发生调整',
      includedGroupId: 'policy-treasury-rates',
    });
  }

  if (policyEvidence) {
    const effr = indicators.get('effr');
    const targetIndicator = indicators.get('federal_funds_target_range');
    const target = latestTargetRangeAt(targetIndicator, effr.observationDate);
    if (target && (effr.value < target.lower || effr.value > target.upper)) {
      const location = effr.value < target.lower ? '低于' : '高于';
      events.push({
        id: `effr-outside-target-range-${policyEvidence.currentDate}`,
        ruleId: 'effr-outside-target-range',
        indicatorIds: ['effr', 'federal_funds_target_range'],
        date: policyEvidence.currentDate,
        text: `EFFR为${fixedText(effr.value)}%，${location}目标区间`,
        includedGroupId: 'policy-treasury-rates',
      });
    }
  }

  const facilityRules = [
    ['srf_repo_accepted', 'srf-zero-to-positive', 'bank-credit', 'SRF接受量'],
    ['discount_window_primary', 'discount-window-zero-to-positive', 'bank-credit', '贴现窗口一级信贷'],
    ['swap_line_balance', 'swap-line-zero-to-positive', 'offshore-dollar', '美元央行流动性互换余额'],
    ['fima_repo_balance', 'fima-zero-to-positive', 'offshore-dollar', 'FIMA Repo余额'],
  ];
  for (const [indicatorId, ruleId, groupId, label] of facilityRules) {
    const observation = comparisons.get(indicatorId);
    if (!observation || observation.previousValue !== 0 || observation.currentValue <= 0) continue;
    events.push({
      id: `${ruleId}-${observation.currentDate}`,
      ruleId,
      indicatorIds: [indicatorId],
      date: observation.currentDate,
      text: `${label}由零升至${numberText(observation.currentValue)}亿美元`,
      includedGroupId: groupId,
    });
  }
  return events;
}

function aggregateDirection(directions, mandatory) {
  if (mandatory) return 'event';
  const directional = new Set(directions.filter((direction) => direction !== 'neutral'));
  if (directional.size === 0) return 'neutral';
  if (directional.size > 1) return 'mixed';
  return [...directional][0];
}

function movement(delta, up = '上升', down = '下降') {
  return delta >= 0 ? up : down;
}

function bpDelta(observation) {
  return observation.unit === '%' ? Math.abs(observation.delta * 100) : Math.abs(observation.delta);
}

function genericObservationText(observation, indicator) {
  if (observation.unit === '%') {
    return `${indicator.shortName || indicator.name}${movement(observation.delta)}${numberText(bpDelta(observation))}个基点`;
  }
  if (observation.unit === 'bp') {
    return `${indicator.shortName || indicator.name}${movement(observation.delta, '走阔', '收窄')}${numberText(Math.abs(observation.delta))}个基点`;
  }
  const unit = observation.unit === '亿美元' ? '亿美元' : observation.unit;
  return `${indicator.shortName || indicator.name}${movement(observation.delta, '增加', '减少')}${numberText(Math.abs(observation.delta))}${unit}`;
}

function groupText(groupId, evidence, indicators, events) {
  if (events.length) return events.map((event) => event.text).join('，');
  const byId = new Map(evidence.map((observation) => [observation.indicatorId, observation]));

  if (groupId === 'policy-treasury-rates') {
    const yields = [
      ['treasury_yield_2y', '2年期'],
      ['treasury_yield_5y', '5年期'],
      ['treasury_yield_10y', '10年期'],
    ].filter(([id]) => byId.has(id));
    if (yields.length) {
      const movements = yields.map(([id]) => movement(byId.get(id).delta));
      const sameMovement = movements.every((item) => item === movements[0]);
      if (sameMovement) {
        return `${yields.map(([, label]) => label).join('、')}美债收益率分别${movements[0]}${yields.map(([id]) => numberText(bpDelta(byId.get(id)))).join('、')}个基点`;
      }
    }
  }

  const preferredIds = {
    'broad-financial-conditions': ['ofr_fsi', 'hy_oas', 'vix', 'broad_dollar', 'tips_10y_real_yield', 'sp500'],
    'secured-funding': ['tgcr', 'sofr_onrrp_spread', 'sofr_volume'],
    'bank-credit': ['cp_credit_spread', 'reserve_balances', 'small_bank_deposits', 'small_bank_cash_ratio'],
    'offshore-dollar': ['broad_dollar', 'eurusd_spot', 'usdjpy_spot', 'usdcny_spot'],
    'treasury-supply': ['tga_balance', 'treasury_net_issuance_5d'],
  }[groupId] || evidence.map((observation) => observation.indicatorId);

  return preferredIds
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, 3)
    .map((observation) => genericObservationText(observation, indicators.get(observation.indicatorId)))
    .join('，');
}

function buildGroups(comparisons, indicators, mandatoryEvents) {
  const groups = [];
  for (const definition of groupDefinitions) {
    const mandatory = mandatoryEvents.filter((event) => event.includedGroupId === definition.id);
    const evidence = [];
    const directions = [];
    let priority = 0;

    for (const indicatorId of definition.indicatorIds) {
      const observation = comparisons.get(indicatorId);
      const rule = rules.get(indicatorId);
      const eventEvidence = mandatory.some((event) => event.indicatorIds.includes(indicatorId));
      if (!observation || (!rule && !eventEvidence)) continue;
      const result = rule
        ? rule.evaluate(observation)
        : { significant: false, score: 0 };
      if (!result.significant && !eventEvidence) continue;
      const triggerRules = [];
      if (result.significant) triggerRules.push(rule.label);
      for (const event of mandatory.filter((item) => item.indicatorIds.includes(indicatorId))) {
        triggerRules.push(event.ruleId);
      }
      evidence.push({ ...observation, triggerRules });
      directions.push(directionFor(observation, rule));
      priority = Math.max(priority, result.score);
    }

    if (mandatory.length && evidence.length === 0) {
      const fallback = definition.indicatorIds.map((id) => comparisons.get(id)).find(Boolean);
      if (fallback) {
        evidence.push({
          ...fallback,
          triggerRules: mandatory.map((event) => event.ruleId),
        });
      }
    }

    if (!evidence.length && !mandatory.length) continue;
    const contextIds = {
      'policy-treasury-rates': ['treasury_yield_2y', 'treasury_yield_5y', 'treasury_yield_10y'],
      'secured-funding': ['tgcr', 'sofr_onrrp_spread', 'sofr_volume'],
      'treasury-supply': ['tga_balance', 'treasury_net_issuance_5d'],
    }[definition.id] || [];
    const evidenceIds = new Set(evidence.map((observation) => observation.indicatorId));
    for (const indicatorId of contextIds) {
      const observation = comparisons.get(indicatorId);
      if (!observation || evidenceIds.has(indicatorId)) continue;
      const rule = rules.get(indicatorId);
      const result = rule?.evaluate(observation);
      evidence.push({
        ...observation,
        triggerRules: result?.significant ? [rule.label] : [],
      });
    }
    const isMandatory = mandatory.length > 0;
    const direction = aggregateDirection(directions, isMandatory);
    groups.push({
      groupId: definition.id,
      direction,
      mandatory: isMandatory,
      priority: round(priority + (groupPriorityWeights.get(definition.id) || 0) + (isMandatory ? 100 : 0), 4),
      text: groupText(definition.id, evidence, indicators, mandatory),
      mandatoryEventIds: mandatory.map((event) => event.id),
      observations: evidence,
    });
  }
  return groups;
}

function buildConclusion(selectedChanges, mandatoryEvents) {
  if (mandatoryEvents.length) {
    return '政策利率或后备流动性工具出现需优先核验的变化。';
  }
  if (!selectedChanges.length) return '新增观察未触发显著变化。';

  const easingIds = selectedChanges.filter((change) => change.direction === 'easing').map((change) => change.groupId);
  const tighteningIds = selectedChanges.filter((change) => change.direction === 'tightening').map((change) => change.groupId);
  if (easingIds.includes('treasury-supply')
    && easingIds.includes('secured-funding')
    && tighteningIds.includes('policy-treasury-rates')) {
    return '信号分化，财政现金与担保融资边际缓和，美债收益率曲线上移。';
  }

  const directions = new Set(selectedChanges.map((change) => change.direction).filter((direction) => (
    direction === 'tightening' || direction === 'easing'
  )));
  if (directions.size > 1 || selectedChanges.some((change) => change.direction === 'mixed')) {
    return '松紧信号分化，暂未形成单一方向。';
  }
  if (directions.has('tightening')) return '美元流动性相关条件边际收紧。';
  if (directions.has('easing')) return '美元流动性相关条件边际缓和。';
  return '新增观察以成交量和政策锚变化为主。';
}

function buildDataLine(snapshot, indicators) {
  const meta = snapshot.meta;
  const quality = meta.sourceFailureCount === 0
    ? `${meta.sourceSuccessCount}个数据源全部成功`
    : `${meta.sourceSuccessCount}个数据源成功，${meta.sourceFailureCount}个失败`;
  const completeness = meta.staleIndicatorCount || meta.missingIndicatorCount
    ? `${meta.usableIndicatorCount}项指标可用，${meta.staleIndicatorCount}项待更新，${meta.missingIndicatorCount}项缺失`
    : `${meta.usableIndicatorCount}项指标可用，无陈旧或缺失`;
  const target = indicators.get('federal_funds_target_range');
  const effr = indicators.get('effr');
  if (target.status === 'missing' || effr.status === 'missing') return `${quality}，${completeness}。`;
  const range = latestTargetRangeAt(target, effr.observationDate);
  if (!range) return `${quality}，${completeness}。`;
  const location = effr.value < range.lower
    ? '低于区间'
    : effr.value > range.upper
      ? '高于区间'
      : '处于区间内';
  const currentRange = latestTargetRangeAt(target, target.observationDate);
  return `${quality}，${completeness}；联邦基金目标区间为${fixedText(currentRange.lower)}%至${fixedText(currentRange.upper)}%（${target.observationDate}），EFFR为${fixedText(effr.value)}%（${effr.observationDate}），相对该观察日的目标区间${fixedText(range.lower)}%至${fixedText(range.upper)}%${location}。`;
}

function noNewObservationSummary(candidate, base, indicators) {
  return {
    schemaVersion: '1.0.0',
    ruleVersion: '1.0.0',
    requestedDate,
    generatedAt: new Date().toISOString(),
    state: 'unchanged',
    comparison: {
      mode: 'no-new-observations',
      baseRequestedDate: base.meta.requestedDate,
      baseGeneratedAt: base.meta.generatedAt,
    },
    newObservationCount: 0,
    significantGroupCount: 0,
    selectedChangeCount: 0,
    lines: {
      conclusion: '本期暂无新增观察，前期判断不变。',
      changes: '较上一正式快照没有新增数据点。',
      data: buildDataLine(candidate, indicators),
    },
    selectedChanges: [],
    mandatoryEvents: [],
    mandatoryAudit: {
      checkedRules: mandatoryRuleIds,
      detectedEventCount: 0,
      includedEventCount: 0,
    },
    omittedSignificantGroupIds: [],
  };
}

const candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
validateUsLiquiditySnapshot(candidate, { expectedRequestedDate: requestedDate });
const candidateIndicators = flattenIndicators(candidate);

function discloseEmptySnapshot() {
  if (candidate.meta.usableIndicatorCount !== 0) return;
  candidate.dailySummary.state = 'insufficient';
  candidate.dailySummary.lines.conclusion = '当前尚无可用数据，暂不能判断美元流动性变化。';
  candidate.dailySummary.lines.changes = '等待实际数据抓取完成后整理新增观察。';
}

let base = null;
try {
  base = JSON.parse(await fs.readFile(basePath, 'utf8'));
  validateUsLiquiditySnapshot(base, { expectedRequestedDate: base.meta.requestedDate });
} catch (error) {
  if (!bootstrap) throw new Error(`无法读取旧正式数据，${error.message}`);
}

if (!bootstrap && base.meta.requestedDate > requestedDate) {
  throw new Error(`摘要日期${requestedDate}早于旧正式数据${base.meta.requestedDate}`);
}
if (!bootstrap && !base.dailySummary) {
  throw new Error('旧正式数据缺少日度摘要，首次生成必须显式使用--bootstrap-last-two');
}

const baseIndicators = base ? flattenIndicators(base) : new Map();
const { comparisons, newObservationCount } = buildComparisons(
  candidateIndicators,
  baseIndicators,
  bootstrap,
);

if (!bootstrap && newObservationCount === 0
  && base.meta.requestedDate === requestedDate
  && base.dailySummary) {
  candidate.dailySummary = {
    ...base.dailySummary,
    lines: { ...base.dailySummary.lines, data: buildDataLine(candidate, candidateIndicators) },
  };
  discloseEmptySnapshot();
  validateUsLiquiditySnapshot(candidate, { expectedRequestedDate: requestedDate, requireDailySummary: true });
  await fs.writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  console.log(`美元流动性日度摘要沿用  日期 ${requestedDate}`);
  process.exit(0);
}

if (!bootstrap && newObservationCount === 0) {
  candidate.dailySummary = noNewObservationSummary(candidate, base, candidateIndicators);
} else {
  const mandatoryEvents = createMandatoryEvents(comparisons, candidateIndicators);
  const significantGroups = buildGroups(comparisons, candidateIndicators, mandatoryEvents)
    .sort((left, right) => right.priority - left.priority);
  const mandatoryGroups = significantGroups.filter((group) => group.mandatory);
  if (mandatoryGroups.length > 3) {
    throw new Error('强制事件分布超过3个摘要组，无法在不遗漏的情况下发布');
  }
  const selectedChanges = [
    ...mandatoryGroups,
    ...significantGroups.filter((group) => !group.mandatory),
  ].slice(0, 3);
  const selectedIds = new Set(selectedChanges.map((change) => change.groupId));
  const omittedSignificantGroupIds = significantGroups
    .filter((change) => !selectedIds.has(change.groupId))
    .map((change) => change.groupId);
  const state = mandatoryEvents.length
    ? 'attention'
    : selectedChanges.length === 0
      ? 'unchanged'
      : buildConclusion(selectedChanges, mandatoryEvents).startsWith('松紧信号分化')
        || buildConclusion(selectedChanges, mandatoryEvents).startsWith('信号分化')
        ? 'mixed'
        : selectedChanges.every((change) => change.direction === 'tightening')
          ? 'tightening'
          : selectedChanges.every((change) => change.direction === 'easing')
            ? 'easing'
            : 'mixed';
  const conclusion = buildConclusion(selectedChanges, mandatoryEvents);
  candidate.dailySummary = {
    schemaVersion: '1.0.0',
    ruleVersion: '1.0.0',
    requestedDate,
    generatedAt: new Date().toISOString(),
    state,
    comparison: {
      mode: bootstrap ? 'bootstrap-last-two' : 'candidate-vs-published',
      baseRequestedDate: bootstrap ? null : base.meta.requestedDate,
      baseGeneratedAt: bootstrap ? null : base.meta.generatedAt,
    },
    newObservationCount,
    significantGroupCount: significantGroups.length,
    selectedChangeCount: selectedChanges.length,
    lines: {
      conclusion,
      changes: selectedChanges.length
        ? `${selectedChanges.map((change) => change.text).join('；')}。`
        : '新增观察均未达到显著变化阈值。',
      data: buildDataLine(candidate, candidateIndicators),
    },
    selectedChanges,
    mandatoryEvents,
    mandatoryAudit: {
      checkedRules: mandatoryRuleIds,
      detectedEventCount: mandatoryEvents.length,
      includedEventCount: mandatoryEvents.length,
    },
    omittedSignificantGroupIds,
  };
}

discloseEmptySnapshot();
validateUsLiquiditySnapshot(candidate, { expectedRequestedDate: requestedDate, requireDailySummary: true });
await fs.writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
console.log(`美元流动性日度摘要生成完成  日期 ${requestedDate}  新增观察 ${newObservationCount}`);
console.log(`摘要 ${candidate.dailySummary.lines.conclusion}`);
