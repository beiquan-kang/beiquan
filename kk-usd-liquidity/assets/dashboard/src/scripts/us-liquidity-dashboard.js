(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SPREAD_INDICATOR = {
    id: 'us_cn_10y_spread',
    name: '中美10年期国债利差',
    shortName: '中美10年期国债利差',
  };
  const RANGE_OPTIONS = [
    { id: '3m', label: '3个月', months: 3 },
    { id: '6m', label: '6个月', months: 6 },
    { id: '1y', label: '1年', months: 12 },
    { id: '3y', label: '3年', months: 36 },
    { id: '10y', label: '10年', months: 120 },
    { id: 'all', label: '全部', months: null },
  ];

  const payload = globalThis.__US_LIQUIDITY_DASHBOARD__;
  document.querySelectorAll('[data-us-liquidity-dashboard]').forEach((root) => {
    if (root.dataset.ready === 'true') return;
    root.dataset.ready = 'true';
    try {
      if (!payload || !Array.isArray(payload.modules) || !payload.indicators) {
        throw new Error('美元流动性数据文件没有载入');
      }
      initializeDashboard(root, payload);
    } catch (error) {
      showFatal(root, error);
    }
  });

  function initializeDashboard(root, data) {
    const indicators = Object.fromEntries(
      Object.entries(data.indicators).map(([id, indicator]) => [id, normalizeIndicator(indicator)]),
    );
    // 利差沿用独立利率快照，只在页面中加入栏目与导航。
    const spreadChart = root.querySelector('[data-us-rate-charts]');
    const modules = data.modules.map((module) => {
      if (module.id !== 'policy-treasury-rates' || !spreadChart) return module;
      indicators[SPREAD_INDICATOR.id] = SPREAD_INDICATOR;
      return {
        ...module,
        indicatorIds: [...module.indicatorIds, SPREAD_INDICATOR.id],
      };
    });
    renderDailySummary(root, data);
    const state = root.querySelector('[data-usl-data-state]');
    const usableCount = Number.isFinite(Number(data.meta?.usableIndicatorCount))
      ? Number(data.meta.usableIndicatorCount)
      : Object.keys(indicators).length;
    const staleCount = Number.isFinite(Number(data.meta?.staleIndicatorCount))
      ? Number(data.meta.staleIndicatorCount)
      : 0;
    const missingCount = Number.isFinite(Number(data.meta?.missingIndicatorCount))
      ? Number(data.meta.missingIndicatorCount)
      : 0;
    const requestedDate = data.meta?.requestedDate || '';
    state.replaceChildren(
      element('strong', missingCount ? `存在${missingCount}项数据缺口` : `${usableCount}项指标可用`),
      element('small', `检查日 ${formatChineseDate(requestedDate)}，${usableCount}项可用，${staleCount}项待更新`),
    );
    if (data.meta?.generatedAt) {
      const readTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(data.meta.generatedAt));
      const audit = data.meta.refreshAudit;
      state.append(element('small', `北京时间 ${readTime} 抓取${audit ? ` · ${audit.advancedIndicatorCount}项新增观测，${audit.unchangedObservationCount}项源端暂无新增` : ''}`));
    }

    const modulesHost = root.querySelector('[data-usl-modules]');
    const fragment = document.createDocumentFragment();
    modules.forEach((module, index) => {
      fragment.append(createModule(root, module, indicators, index));
    });
    modulesHost.replaceChildren(fragment);
    renderNavigation(root, modules, indicators);
    restoreInitialAnchor(root);
  }

  function renderDailySummary(root, data) {
    const summary = data.dailySummary;
    const date = summary?.requestedDate || data.meta?.requestedDate || '';
    const conclusion = summary?.lines?.conclusion || '本期日度摘要尚未生成';
    const changes = summary?.lines?.changes || '完成下一次日度更新后生成关键变化';
    const dataLine = summary?.lines?.data
      || `${Number(data.meta?.sourceSuccessCount) || 0}个数据源成功，${Number(data.meta?.usableIndicatorCount) || 0}项指标可用`;
    const dateNode = root.querySelector('[data-usl-summary-date]');
    const conclusionNode = root.querySelector('[data-usl-summary-conclusion]');
    const changesNode = root.querySelector('[data-usl-summary-changes]');
    const dataNode = root.querySelector('[data-usl-summary-data]');
    dateNode.dateTime = date;
    dateNode.textContent = `${formatChineseDate(date)}更新`;
    conclusionNode.textContent = conclusion;
    changesNode.textContent = changes;
    dataNode.textContent = dataLine;
  }

  function normalizeIndicator(indicator) {
    return {
      ...indicator,
      history: normalizeHistory(indicator.history),
      rangeHistory: Array.isArray(indicator.rangeHistory)
        ? indicator.rangeHistory
          .filter((point) => Array.isArray(point) && point.length >= 3)
          .map(([date, lower, upper]) => ({ date, lower: Number(lower), upper: Number(upper) }))
          .filter((point) => point.date && Number.isFinite(point.lower) && Number.isFinite(point.upper))
        : [],
    };
  }

  function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
      .filter((point) => Array.isArray(point) && point.length >= 2)
      .map(([date, value]) => ({ date, value: Number(value) }))
      .filter((point) => point.date && Number.isFinite(point.value));
  }

  function visibleIndicatorIds(module) {
    return module.indicatorIds.filter(
      (id) => !(module.id === 'broad-financial-conditions' && id === 'sp500'),
    );
  }

  function moduleAnchorId(module, moduleIndex) {
    return `usl-module-${moduleIndex + 1}-${safeFragmentId(module.id)}`;
  }

  function indicatorAnchorId(module, indicator, moduleIndex, indicatorIndex) {
    return `usl-indicator-${moduleIndex + 1}-${indicatorIndex + 1}-${safeFragmentId(module.id)}-${safeFragmentId(indicator.id)}`;
  }

  function renderNavigation(root, modules, indicators) {
    const navigation = root.querySelector('[data-usl-navigation]');
    const mobileNavigation = root.querySelector('[data-usl-mobile-navigation]');
    const visibleCount = modules.reduce((count, module) => count + visibleIndicatorIds(module).length, 0);
    const head = element('header', '', 'usl-nav-head');
    head.append(
      element('span', '指标导航'),
      element('strong', '快速定位'),
      element('small', `${visibleCount}张图表，滚动时保持显示`),
    );
    const groups = element('div', '', 'usl-nav-groups');
    const selectLabel = element('label');
    selectLabel.append(element('span', '快速定位'));
    const select = element('select');
    select.setAttribute('aria-label', '选择美元流动性指标');
    const placeholder = element('option', '选择指标');
    placeholder.value = '';
    select.append(placeholder);
    selectLabel.append(select);

    const linkByTargetId = new Map();
    modules.forEach((module, moduleIndex) => {
      const group = element('section', '', 'usl-nav-group');
      const moduleId = moduleAnchorId(module, moduleIndex);
      const moduleLink = element('a', module.title, 'usl-nav-module-link');
      moduleLink.href = `#${moduleId}`;
      moduleLink.addEventListener('click', (event) => navigateToTarget(root, moduleId, event));
      group.append(moduleLink);

      const list = element('ol', '', 'usl-nav-list');
      const optionGroup = element('optgroup');
      optionGroup.label = module.title;
      visibleIndicatorIds(module).forEach((id, indicatorIndex) => {
        const indicator = indicators[id];
        if (!indicator) return;
        const targetId = indicatorAnchorId(module, indicator, moduleIndex, indicatorIndex);
        const item = element('li');
        const link = element('a', '', 'usl-nav-link');
        link.href = `#${targetId}`;
        link.dataset.targetId = targetId;
        link.append(
          element('span', String(indicatorIndex + 1).padStart(2, '0')),
          element('span', indicator.shortName || indicator.name),
        );
        link.addEventListener('click', (event) => {
          navigateToTarget(root, targetId, event);
          setActiveNavigationLink(linkByTargetId, targetId, select);
        });
        item.append(link);
        list.append(item);
        linkByTargetId.set(targetId, link);

        const option = element('option', indicator.name);
        option.value = targetId;
        optionGroup.append(option);
      });
      group.append(list);
      groups.append(group);
      select.append(optionGroup);
    });
    navigation.replaceChildren(head, groups);
    mobileNavigation.replaceChildren(selectLabel);

    select.addEventListener('change', () => {
      if (!select.value) return;
      navigateToTarget(root, select.value);
      setActiveNavigationLink(linkByTargetId, select.value, select);
    });

    const firstTargetId = linkByTargetId.keys().next().value;
    if (firstTargetId) setActiveNavigationLink(linkByTargetId, firstTargetId, select);
    observeIndicators(root, linkByTargetId, select);
  }

  function navigateToTarget(root, targetId, event = null) {
    if (event) event.preventDefault();
    const target = document.getElementById(targetId);
    if (!target || !root.contains(target)) return;
    const module = target.matches('.usl-module') ? target : target.closest('.usl-module');
    if (module) module.open = true;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      const focusTarget = target.matches('.usl-module')
        ? target.querySelector(':scope > summary')
        : target;
      focusTarget?.focus({ preventScroll: true });
      try {
        history.replaceState(null, '', `#${targetId}`);
      } catch {}
    });
  }

  function setActiveNavigationLink(linkByTargetId, targetId, select) {
    linkByTargetId.forEach((link, id) => {
      if (id === targetId) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    if (select.value !== targetId) select.value = targetId;
  }

  function observeIndicators(root, linkByTargetId, select) {
    if (!('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => Math.abs(left.boundingClientRect.top - 96) - Math.abs(right.boundingClientRect.top - 96));
      const targetId = visible[0]?.target.id;
      if (targetId && linkByTargetId.has(targetId)) {
        setActiveNavigationLink(linkByTargetId, targetId, select);
      }
    }, {
      rootMargin: '-88px 0px -64% 0px',
      threshold: [0, 0.01],
    });
    root.querySelectorAll('.usl-indicator').forEach((indicator) => observer.observe(indicator));
  }

  function restoreInitialAnchor(root) {
    const targetId = decodeURIComponent(window.location.hash.slice(1));
    if (!targetId) return;
    const target = document.getElementById(targetId);
    if (!target || !root.contains(target)) return;
    const module = target.matches('.usl-module') ? target : target.closest('.usl-module');
    if (module) module.open = true;
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }

  function createModule(root, module, indicators, moduleIndex) {
    const details = element('details', '', 'usl-module');
    details.open = true;
    details.dataset.moduleId = module.id;
    details.id = moduleAnchorId(module, moduleIndex);

    const visibleIds = visibleIndicatorIds(module);
    const summary = element('summary', '', 'usl-module-summary');
    const title = element('span', '', 'usl-module-title');
    title.append(element('strong', module.title), element('small', module.summary));
    summary.append(
      title,
      element('span', `${visibleIds.length}张图表`, 'usl-module-count'),
      element('span', '⌃', 'usl-chevron'),
    );

    const list = element('div', '', 'usl-indicator-list');
    const sp500 = module.id === 'broad-financial-conditions' ? indicators.sp500 : null;
    visibleIds.forEach((id, indicatorIndex) => {
      const indicator = indicators[id];
      if (!indicator) return;
      list.append(createIndicator(root, module, indicator, sp500, moduleIndex, indicatorIndex));
    });
    details.append(summary, list);
    return details;
  }

  function createIndicator(root, module, indicator, sp500, moduleIndex, indicatorIndex) {
    if (indicator.id === SPREAD_INDICATOR.id) {
      const article = root.querySelector('[data-us-rate-charts]');
      article.id = indicatorAnchorId(module, indicator, moduleIndex, indicatorIndex);
      article.tabIndex = -1;
      return article;
    }
    const article = element('article', '', 'usl-indicator');
    article.dataset.indicatorId = indicator.id;
    article.dataset.defaultRange = '10y';
    article.dataset.range = '10y';
    article.id = indicatorAnchorId(module, indicator, moduleIndex, indicatorIndex);
    article.tabIndex = -1;

    const header = element('header', '', 'usl-indicator-head');
    const title = element('div', '', 'usl-indicator-title');
    title.append(element('h3', indicator.name));
    const current = element('div', '', 'usl-current-line');
    const valueText = isTargetRange(indicator)
      ? `${formatMetricNumber(indicator.rangeLow, indicator.unit)}至${formatMetricNumber(indicator.rangeHigh, indicator.unit)}`
      : formatMetricNumber(indicator.value, indicator.unit, indicator.displayDigits);
    current.append(element('strong', valueText, 'usl-current-value'));
    if (indicator.unit) current.append(element('span', indicator.unit, 'usl-current-unit'));
    if (Number.isFinite(Number(indicator.change))) {
      const change = Number(indicator.change);
      const changeNode = element(
        'span',
        `${indicator.changeLabel || '变化'} ${formatSignedNumber(change, indicator.changeUnit || indicator.unit)}`,
        `usl-current-change${change > 0 ? ' is-positive' : change < 0 ? ' is-negative' : ''}`,
      );
      current.append(changeNode);
    }
    title.append(current);
    if (['treasury_yield_2y', 'treasury_yield_5y', 'treasury_yield_10y'].includes(indicator.id)) {
      const context = globalThis.__treasuryContext(indicator.history, payload.meta.requestedDate);
      const note = element('div', '', 'usl-treasury-context');
      const change = context.changeBp == null
        ? `${context.year}年以来变化暂无可比数据`
        : `${context.year}年以来 ${formatSignedNumber(context.changeBp, 'bp')}`;
      const yearNode = element('span', change, 'usl-ytd-change');
      if (context.baseline) yearNode.title = `基准 ${context.baseline.date} ${context.baseline.value}% · 最新 ${context.latest.date} ${context.latest.value}%`;
      note.append(yearNode);
      for (const peak of context.historicalPeaks) {
        const difference = peak.differenceBp === 0 ? '当前持平'
          : `当前${peak.differenceBp < 0 ? '低' : '高'}${Math.abs(peak.differenceBp)}bp`;
        const peakNode = element('span', `${peak.year}年最高 ${peak.value.toFixed(2)}%（${difference}）`, 'usl-historical-peak');
        peakNode.title = `历史阶段高点 ${peak.date} · 按相邻完整年度高点识别，优先展示当前尚未超过且差距最小的两个阶段高点`;
        note.append(peakNode);
      }
      title.append(note);
    }

    const observation = element('div', '', 'usl-observation');
    const statusLabel = indicator.status === 'ok'
      ? '数据正常'
      : indicator.status === 'stale'
        ? '数据待更新'
        : indicator.status === 'missing'
          ? '数据缺失'
          : '数据异常';
    observation.append(
      element('strong', `观察日 ${formatChineseDate(indicator.observationDate)}`),
      element('span', statusLabel, indicator.status === 'ok' ? '' : 'is-stale'),
    );
    header.append(title, observation);

    const toolbar = element('div', '', 'usl-chart-toolbar');
    const rangeList = element('div', '', 'usl-range-list');
    rangeList.setAttribute('role', 'group');
    rangeList.setAttribute('aria-label', `${indicator.name}图表区间`);
    const buttons = [];
    RANGE_OPTIONS.forEach((option) => {
      const button = element('button', option.label, 'usl-range-button');
      button.type = 'button';
      button.dataset.rangeId = option.id;
      button.setAttribute('aria-pressed', option.id === '10y' ? 'true' : 'false');
      buttons.push(button);
      rangeList.append(button);
    });
    const exportButton = element('button', '导出当前区间Excel', 'usl-export-button');
    exportButton.type = 'button';
    toolbar.append(rangeList, exportButton);

    const layout = element('div', '', 'usl-chart-layout');
    const chartHost = element('div', '', 'usl-chart-host');
    chartHost.dataset.chartHost = indicator.id;
    const statsHost = element('aside', '', 'usl-chart-stats');
    layout.append(chartHost, statsHost);

    let selectedRange = '10y';
    const redraw = () => renderIndicatorChart(chartHost, statsHost, module, indicator, sp500, selectedRange);
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        selectedRange = button.dataset.rangeId;
        article.dataset.range = selectedRange;
        buttons.forEach((candidate) => candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false'));
        redraw();
      });
    });
    exportButton.addEventListener('click', () => {
      try {
        exportIndicatorToXlsx(indicator, selectedRange);
        const label = RANGE_OPTIONS.find((option) => option.id === selectedRange)?.label || '当前区间';
        showToast(root, `${indicator.name}${label}数据已导出`);
      } catch (error) {
        showToast(root, `导出失败，${safeErrorMessage(error)}`, true);
      }
    });

    const method = createMethodDetails(indicator, moduleIndex, indicatorIndex);
    article.append(header);
    if (isTargetRange(indicator)) {
      const historyDetails = element('details', '', 'usl-target-history');
      historyDetails.append(element('summary', '联邦基金目标区间历史走势 · 点击展开'), toolbar, layout);
      article.append(historyDetails);
      globalThis.__renderFedExpectations(article);
      article.append(method);
    } else {
      article.append(toolbar, layout, method);
    }
    redraw();
    return article;
  }

  function createMethodDetails(indicator, moduleIndex, indicatorIndex) {
    const details = element('details', '', 'usl-method');
    details.dataset.methodFor = indicator.id;
    const methodId = `usl-method-${moduleIndex}-${indicatorIndex}`;
    const summary = element('summary', '', 'usl-method-summary');
    summary.setAttribute('aria-controls', methodId);
    summary.append(
      element('span', '指标口径与数据说明'),
      element('small', '点击展开'),
      element('span', '⌃', 'usl-chevron'),
    );
    const grid = element('div', '', 'usl-definition-grid');
    grid.id = methodId;
    grid.append(
      definitionBlock('定义', indicator.definition),
      definitionBlock('公式', indicator.formula, true),
      definitionBlock('如何观察', indicator.direction),
      definitionBlock('更新频率', indicator.frequency),
      sourceBlock(indicator),
      definitionBlock('口径限制', indicator.limitation),
    );
    details.append(summary, grid);
    return details;
  }

  function definitionBlock(title, content, asCode = false) {
    const block = element('section', '', 'usl-definition-block');
    block.append(element('h4', title));
    block.append(element(asCode ? 'code' : 'p', content || '暂无说明'));
    return block;
  }

  function sourceBlock(indicator) {
    const block = element('section', '', 'usl-definition-block');
    block.append(element('h4', '数据来源'));
    const line = element('p');
    if (isSafeHttpUrl(indicator.sourceUrl)) {
      const link = element('a', indicator.sourceName || indicator.sourceUrl, 'usl-source-link');
      link.href = indicator.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    } else {
      line.append(document.createTextNode(indicator.sourceName || '暂无来源'));
    }
    if (indicator.seriesId) line.append(element('span', indicator.seriesId, 'usl-source-series'));
    if (indicator.sourceSeriesId) line.append(element('span', `数据源 ${indicator.sourceSeriesId}`, 'usl-source-series'));
    block.append(line);
    return block;
  }

  function renderIndicatorChart(chartHost, statsHost, module, indicator, sp500, rangeId) {
    chartHost.replaceChildren();
    statsHost.replaceChildren();
    const history = filterHistoryByRange(indicator.history, rangeId);
    const stats = calculateRangeStats(history, rangeId);
    renderStatistics(statsHost, stats, indicator.unit);
    if (history.length < 2) {
      const empty = element('div', '', 'usl-chart-empty');
      empty.append(
        element('strong', history.length ? '当前区间只有一个有效观察值' : '当前区间没有历史数据'),
        element('span', '可切换更长区间查看'),
      );
      chartHost.append(empty);
      return;
    }

    const secondaryHistory = module.id === 'broad-financial-conditions' && sp500
      ? filterHistoryByCalendarWindow(sp500.history, history[0].date, history.at(-1).date)
      : [];
    const rangeHistory = isTargetRange(indicator)
      ? filterRangeHistoryByCalendarWindow(indicator.rangeHistory, history[0].date, history.at(-1).date)
      : [];

    if (secondaryHistory.length >= 2 || rangeHistory.length >= 2) {
      const legend = element('div', '', 'usl-chart-legend');
      const primary = element('span', '', 'usl-legend-item');
      primary.append(element('i'), document.createTextNode(`${indicator.name}，左轴`));
      legend.append(primary);
      if (rangeHistory.length >= 2) {
        const band = element('span', '', 'usl-legend-item');
        band.append(element('i'), document.createTextNode('目标区间上下限'));
        legend.append(band);
      }
      if (secondaryHistory.length >= 2) {
        const secondary = element('span', '', 'usl-legend-item is-secondary');
        secondary.append(element('i'), document.createTextNode(`${sp500.name}，右轴`));
        legend.append(secondary, element('small', '同一日历横轴，不填充缺失交易日', 'usl-legend-note'));
      }
      chartHost.append(legend);
    }
    chartHost.append(createHistoryChart(chartHost, history, stats, indicator, sp500, secondaryHistory, rangeHistory));
  }

  function filterHistoryByRange(history, rangeId) {
    if (!history.length || rangeId === 'all') return [...history];
    const option = RANGE_OPTIONS.find((candidate) => candidate.id === rangeId) || RANGE_OPTIONS[0];
    const lastDate = parseDate(history.at(-1).date);
    if (!lastDate || option.months == null) return [...history];
    const cutoff = new Date(lastDate);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - option.months);
    return history.filter((point) => {
      const date = parseDate(point.date);
      return date && date >= cutoff && date <= lastDate;
    });
  }

  function filterHistoryByCalendarWindow(history, startDate, endDate) {
    return history.filter((point) => point.date >= startDate && point.date <= endDate);
  }

  function filterRangeHistoryByCalendarWindow(history, startDate, endDate) {
    return history.filter((point) => point.date >= startDate && point.date <= endDate);
  }

  function calculateRangeStats(history, rangeId) {
    if (!history.length) return null;
    const mean = history.reduce((sum, point) => sum + point.value, 0) / history.length;
    const variance = history.reduce((sum, point) => sum + (point.value - mean) ** 2, 0) / history.length;
    const deviation = Math.sqrt(variance);
    return {
      mean,
      deviation,
      count: history.length,
      start: history[0].date,
      end: history.at(-1).date,
      rangeId,
      references: [
        { label: '+2倍标准差', value: mean + 2 * deviation, level: 'two' },
        { label: '+1倍标准差', value: mean + deviation, level: 'one' },
        { label: '平均值', value: mean, level: 'mean' },
        { label: '-1倍标准差', value: mean - deviation, level: 'one' },
        { label: '-2倍标准差', value: mean - 2 * deviation, level: 'two' },
      ],
    };
  }

  function renderStatistics(host, stats, unit) {
    host.append(element('h4', '当前区间统计'));
    if (!stats) {
      host.append(element('p', '缺少可计算的历史数据', 'usl-stats-period'));
      return;
    }
    const rangeLabel = RANGE_OPTIONS.find((option) => option.id === stats.rangeId)?.label || '当前区间';
    host.append(element(
      'p',
      `${rangeLabel}，${formatChineseDate(stats.start)}至${formatChineseDate(stats.end)}，共${stats.count}个观察值`,
      'usl-stats-period',
    ));
    const list = element('dl', '', 'usl-reference-list');
    stats.references.forEach((reference) => {
      const row = element('div', '', `usl-reference-row is-${reference.level}`);
      const term = element('dt');
      term.append(element('i', '', 'usl-reference-swatch'), document.createTextNode(reference.label));
      row.append(
        term,
        element('dd', `${formatMetricNumber(reference.value, unit)}${unit ? ` ${unit}` : ''}`),
      );
      list.append(row);
    });
    host.append(list);
  }

  function createHistoryChart(chartHost, history, stats, indicator, secondaryIndicator, secondaryHistory, rangeHistory) {
    const width = 960;
    const height = 330;
    const hasSecondary = Boolean(secondaryIndicator && secondaryHistory.length >= 2);
    const margin = { top: 18, right: hasSecondary ? 82 : 22, bottom: 42, left: 70 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const sampled = downsampleHistory(history, 900);
    const secondarySampled = hasSecondary ? downsampleHistory(secondaryHistory, 900) : [];
    const rangeByDate = new Map(rangeHistory.map((point) => [point.date, point]));
    const sampledRange = sampled.map((point) => rangeByDate.get(point.date)).filter(Boolean);

    const yValues = sampled.map((point) => point.value);
    if (stats) yValues.push(...stats.references.map((reference) => reference.value));
    sampledRange.forEach((point) => yValues.push(point.lower, point.upper));
    let yMin = Math.min(...yValues);
    let yMax = Math.max(...yValues);
    const rawRange = yMax - yMin;
    const yPadding = rawRange ? rawRange * 0.07 : Math.max(Math.abs(yMax) * 0.07, 1);
    yMin -= yPadding;
    yMax += yPadding;

    const firstTime = parseDate(sampled[0].date).getTime();
    const lastTime = parseDate(sampled.at(-1).date).getTime();
    const timeRange = lastTime - firstTime || 1;
    const x = (point) => margin.left + ((parseDate(point.date).getTime() - firstTime) / timeRange) * plotWidth;
    const y = (value) => margin.top + ((yMax - value) / (yMax - yMin || 1)) * plotHeight;

    let secondaryMin = 0;
    let secondaryMax = 1;
    let secondaryY = () => margin.top + plotHeight / 2;
    if (hasSecondary) {
      const values = secondarySampled.map((point) => point.value);
      secondaryMin = Math.min(...values);
      secondaryMax = Math.max(...values);
      const spread = secondaryMax - secondaryMin;
      const padding = spread ? spread * 0.07 : Math.max(Math.abs(secondaryMax) * 0.07, 1);
      secondaryMin -= padding;
      secondaryMax += padding;
      secondaryY = (value) => margin.top + ((secondaryMax - value) / (secondaryMax - secondaryMin || 1)) * plotHeight;
    }

    const svg = svgElement('svg', 'usl-history-chart');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute(
      'aria-label',
      `${indicator.name}从${formatChineseDate(sampled[0].date)}至${formatChineseDate(sampled.at(-1).date)}的走势`,
    );
    const title = svgElement('title');
    title.textContent = `${indicator.name}历史走势`;
    svg.append(title);

    for (let index = 0; index <= 4; index += 1) {
      const value = yMax - (index / 4) * (yMax - yMin);
      appendSvgLine(svg, margin.left, y(value), width - margin.right, y(value), 'usl-axis-grid');
      appendSvgText(svg, margin.left - 10, y(value) + 4, formatAxisNumber(value, indicator.unit), 'usl-axis-label', 'end');
    }

    if (hasSecondary) {
      appendSvgLine(svg, width - margin.right, margin.top, width - margin.right, height - margin.bottom, 'usl-secondary-axis');
      for (let index = 0; index <= 4; index += 1) {
        const value = secondaryMax - (index / 4) * (secondaryMax - secondaryMin);
        appendSvgText(
          svg,
          width - margin.right + 10,
          secondaryY(value) + 4,
          formatAxisNumber(value, secondaryIndicator.unit),
          'usl-axis-label',
          'start',
        );
      }
    }

    if (sampledRange.length >= 2) {
      const upper = sampledRange.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point.upper).toFixed(2)}`).join(' ');
      const lower = [...sampledRange].reverse().map((point) => `L${x(point).toFixed(2)},${y(point.lower).toFixed(2)}`).join(' ');
      const band = svgElement('path', 'usl-target-band');
      band.setAttribute('d', `${upper} ${lower} Z`);
      svg.append(band);
      const upperLine = svgElement('path', 'usl-target-boundary');
      upperLine.setAttribute('d', sampledRange.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point.upper).toFixed(2)}`).join(' '));
      const lowerLine = svgElement('path', 'usl-target-boundary');
      lowerLine.setAttribute('d', sampledRange.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point.lower).toFixed(2)}`).join(' '));
      svg.append(upperLine, lowerLine);
    }

    if (stats) {
      stats.references.forEach((reference) => {
        appendSvgLine(
          svg,
          margin.left,
          y(reference.value),
          width - margin.right,
          y(reference.value),
          `usl-reference-line usl-reference-${reference.level}`,
        );
      });
    }

    const xIndexes = [...new Set([
      0,
      Math.round((sampled.length - 1) * 0.25),
      Math.round((sampled.length - 1) * 0.5),
      Math.round((sampled.length - 1) * 0.75),
      sampled.length - 1,
    ])];
    xIndexes.forEach((index) => {
      const point = sampled[index];
      appendSvgText(
        svg,
        x(point),
        height - 14,
        formatChartDate(point.date),
        'usl-axis-label',
        index === 0 ? 'start' : index === sampled.length - 1 ? 'end' : 'middle',
      );
    });

    if (hasSecondary) {
      const path = svgElement('path', 'usl-secondary-line');
      path.setAttribute('d', secondarySampled.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${secondaryY(point.value).toFixed(2)}`).join(' '));
      svg.append(path);
      const last = secondarySampled.at(-1);
      const dot = svgElement('circle', 'usl-secondary-dot');
      setSvgAttributes(dot, { cx: x(last), cy: secondaryY(last.value), r: 3.5 });
      svg.append(dot);
    }

    const path = svgElement('path', 'usl-history-line');
    path.setAttribute('d', sampled.map((point, index) => `${index ? 'L' : 'M'}${x(point).toFixed(2)},${y(point.value).toFixed(2)}`).join(' '));
    svg.append(path);
    const last = sampled.at(-1);
    const dot = svgElement('circle', 'usl-history-dot');
    setSvgAttributes(dot, { cx: x(last), cy: y(last.value), r: 4 });
    svg.append(dot);

    const hover = svgElement('g');
    hover.setAttribute('hidden', '');
    const hoverLine = appendSvgLine(hover, 0, margin.top, 0, height - margin.bottom, 'usl-hover-line');
    const hoverDot = svgElement('circle', 'usl-hover-dot');
    hoverDot.setAttribute('r', '4');
    hover.append(hoverDot);
    svg.append(hover);

    const tooltip = element('div', '', 'usl-tooltip');
    tooltip.hidden = true;
    chartHost.append(tooltip);

    let keyboardIndex = sampled.length - 1;
    const showPoint = (pointIndex, clientX = null) => {
      keyboardIndex = Math.max(0, Math.min(sampled.length - 1, pointIndex));
      const point = sampled[keyboardIndex];
      const pointX = x(point);
      const pointY = y(point.value);
      hover.removeAttribute('hidden');
      hoverLine.setAttribute('x1', pointX);
      hoverLine.setAttribute('x2', pointX);
      hoverDot.setAttribute('cx', pointX);
      hoverDot.setAttribute('cy', pointY);
      const pieces = [
        formatChineseDate(point.date),
        `${indicator.name} ${formatMetricNumber(point.value, indicator.unit)}${indicator.unit ? ` ${indicator.unit}` : ''}`,
      ];
      const rangePoint = rangeByDate.get(point.date);
      if (rangePoint) pieces.push(`下限 ${formatMetricNumber(rangePoint.lower, indicator.unit)}，上限 ${formatMetricNumber(rangePoint.upper, indicator.unit)}`);
      if (hasSecondary) {
        const secondary = nearestPoint(secondarySampled, parseDate(point.date).getTime());
        pieces.push(`${secondaryIndicator.name} ${formatMetricNumber(secondary.value, secondaryIndicator.unit)}${secondaryIndicator.unit ? ` ${secondaryIndicator.unit}` : ''}`);
      }
      tooltip.textContent = pieces.join('　');
      tooltip.hidden = false;
      const svgBounds = svg.getBoundingClientRect();
      const hostBounds = chartHost.getBoundingClientRect();
      const renderedX = clientX == null
        ? svgBounds.left - hostBounds.left + (pointX / width) * svgBounds.width
        : clientX - hostBounds.left;
      const renderedY = svgBounds.top - hostBounds.top + (pointY / height) * svgBounds.height;
      const preferLeft = renderedX > hostBounds.width * 0.66;
      tooltip.style.left = `${Math.max(8, Math.min(hostBounds.width - 18, renderedX + (preferLeft ? -8 : 8)))}px`;
      tooltip.style.top = `${Math.max(8, renderedY - 38)}px`;
      tooltip.style.transform = preferLeft ? 'translateX(-100%)' : 'none';
    };

    const overlay = svgElement('rect', 'usl-chart-overlay');
    setSvgAttributes(overlay, {
      x: margin.left,
      y: margin.top,
      width: plotWidth,
      height: plotHeight,
      tabindex: 0,
    });
    overlay.setAttribute('aria-label', '移动指针或使用左右方向键查看观察值');
    overlay.addEventListener('pointermove', (event) => {
      const bounds = svg.getBoundingClientRect();
      const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
      const ratio = Math.max(0, Math.min(1, (svgX - margin.left) / plotWidth));
      const targetTime = firstTime + ratio * timeRange;
      showPoint(nearestPointIndex(sampled, targetTime), event.clientX);
    });
    overlay.addEventListener('pointerleave', hideHover);
    overlay.addEventListener('focus', () => showPoint(keyboardIndex));
    overlay.addEventListener('blur', hideHover);
    overlay.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowLeft') keyboardIndex -= 1;
      if (event.key === 'ArrowRight') keyboardIndex += 1;
      if (event.key === 'Home') keyboardIndex = 0;
      if (event.key === 'End') keyboardIndex = sampled.length - 1;
      showPoint(keyboardIndex);
    });
    svg.append(overlay);
    return svg;

    function hideHover() {
      hover.setAttribute('hidden', '');
      tooltip.hidden = true;
    }
  }

  function appendSvgLine(parent, x1, y1, x2, y2, className) {
    const line = svgElement('line', className);
    setSvgAttributes(line, { x1, y1, x2, y2 });
    parent.append(line);
    return line;
  }

  function appendSvgText(parent, x, y, content, className, anchor = 'start') {
    const text = svgElement('text', className);
    setSvgAttributes(text, { x, y, 'text-anchor': anchor });
    text.textContent = content;
    parent.append(text);
    return text;
  }

  function svgElement(name, className = '') {
    const node = document.createElementNS(SVG_NS, name);
    if (className) node.setAttribute('class', className);
    return node;
  }

  function setSvgAttributes(node, attributes) {
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  }

  function nearestPointIndex(points, timestamp) {
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (parseDate(points[middle].date).getTime() < timestamp) low = middle + 1;
      else high = middle;
    }
    if (low === 0) return 0;
    const before = parseDate(points[low - 1].date).getTime();
    const after = parseDate(points[low].date).getTime();
    return timestamp - before <= after - timestamp ? low - 1 : low;
  }

  function nearestPoint(points, timestamp) {
    return points[nearestPointIndex(points, timestamp)];
  }

  function downsampleHistory(history, limit) {
    if (history.length <= limit) return history;
    const result = [history[0]];
    const bucketSize = (history.length - 2) / (limit - 2);
    for (let index = 0; index < limit - 2; index += 1) {
      const start = Math.floor(1 + index * bucketSize);
      const end = Math.min(history.length - 1, Math.floor(1 + (index + 1) * bucketSize));
      const bucket = history.slice(start, Math.max(start + 1, end));
      const minimum = bucket.reduce((best, point) => point.value < best.value ? point : best, bucket[0]);
      const maximum = bucket.reduce((best, point) => point.value > best.value ? point : best, bucket[0]);
      result.push(index % 2 ? maximum : minimum);
    }
    result.push(history.at(-1));
    return result.sort((left, right) => left.date.localeCompare(right.date));
  }

  function isTargetRange(indicator) {
    return indicator.id === 'federal_funds_target_range' && indicator.rangeHistory.length > 0;
  }

  function formatMetricNumber(value, unit = '', displayDigits = null) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '缺口';
    if (unit === '亿美元') {
      if (number !== 0 && Math.abs(number) < 1) return number > 0 ? '小于1' : '大于-1';
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(number);
    }
    if (/bp|基点/i.test(unit)) {
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: Math.abs(number) >= 100 ? 0 : 1 }).format(number);
    }
    if (Number.isInteger(displayDigits) && displayDigits >= 0) {
      return new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: displayDigits,
        maximumFractionDigits: displayDigits,
      }).format(number);
    }
    if (/%|百分比/.test(unit)) {
      return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
    }
    if (unit === '美元/欧元' || unit === '人民币/美元') {
      return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(number);
    }
    if (unit === '日元/美元') {
      return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
    }
    const digits = Math.abs(number) >= 100 ? 0 : Math.abs(number) >= 10 ? 1 : 2;
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number);
  }

  function formatAxisNumber(value, unit = '') {
    return formatMetricNumber(value, unit);
  }

  function formatSignedNumber(value, unit = '') {
    return `${value > 0 ? '+' : ''}${formatMetricNumber(value, unit)}${unit ? ` ${unit}` : ''}`;
  }

  function formatChineseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return value || '待更新';
    return `${Number(match[1])}年${Number(match[2])}月${Number(match[3])}日`;
  }

  function formatChartDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    return match ? `${match[1]}.${match[2]}.${match[3]}` : String(value || '');
  }

  function parseDate(value) {
    if (!value) return null;
    const date = value instanceof Date
      ? new Date(value)
      : new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00Z` : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function exportIndicatorToXlsx(indicator, rangeId) {
    const points = filterHistoryByRange(indicator.history, rangeId);
    if (!points.length) throw new Error('所选区间没有可导出的历史数据');
    let rows;
    if (isTargetRange(indicator)) {
      const rangeByDate = new Map(indicator.rangeHistory.map((point) => [point.date, point]));
      rows = [
        ['日期', '指标', '下限', '上限', '中点', '单位'],
        ...points.map((point) => {
          const range = rangeByDate.get(point.date);
          return [point.date, indicator.name, range?.lower ?? '', range?.upper ?? '', point.value, indicator.unit];
        }),
      ];
    } else {
      rows = [
        ['日期', '指标', '数值', '单位'],
        ...points.map((point) => [point.date, indicator.name, point.value, indicator.unit]),
      ];
    }
    const bytes = createXlsxWorkbook(rows, indicator.unit === '亿美元');
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const rangeLabel = RANGE_OPTIONS.find((option) => option.id === rangeId)?.label || rangeId;
    const safeName = `${indicator.name}_${rangeLabel}`.replace(/[\\/:*?"<>|]/g, '_');
    link.href = url;
    link.download = `${safeName}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function createXlsxWorkbook(rows, integerDisplay) {
    const worksheetRows = rows.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
        if (rowIndex > 0 && typeof value === 'number' && Number.isFinite(value)) {
          return `<c r="${reference}"${integerDisplay ? ' s="2"' : ''}><v>${value}</v></c>`;
        }
        return `<c r="${reference}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t>${escapeXml(String(value ?? ''))}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    const widths = rows[0].map((_, index) => index === 0 ? 14 : index === 1 ? 34 : 16);
    const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
    const lastColumn = columnName(rows[0].length);
    const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${worksheetRows}</sheetData><autoFilter ref="A1:${lastColumn}${rows.length}"/></worksheet>`;
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="指标数据" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF051C2C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
    return createStoredZip([
      { name: '[Content_Types].xml', content: contentTypes },
      { name: '_rels/.rels', content: rootRelationships },
      { name: 'xl/workbook.xml', content: workbook },
      { name: 'xl/_rels/workbook.xml.rels', content: workbookRelationships },
      { name: 'xl/styles.xml', content: styles },
      { name: 'xl/worksheets/sheet1.xml', content: worksheet },
    ]);
  }

  function columnName(index) {
    let value = index;
    let name = '';
    while (value > 0) {
      value -= 1;
      name = String.fromCharCode(65 + (value % 26)) + name;
      value = Math.floor(value / 26);
    }
    return name;
  }

  function escapeXml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    })[character]);
  }

  function createStoredZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    files.forEach((file) => {
      const name = encoder.encode(file.name);
      const bytes = encoder.encode(file.content);
      const checksum = crc32(bytes);
      const localHeader = concatBytes(
        uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0), uint16(dosTime), uint16(dosDate),
        uint32(checksum), uint32(bytes.length), uint32(bytes.length), uint16(name.length), uint16(0), name,
      );
      const localFile = concatBytes(localHeader, bytes);
      localParts.push(localFile);
      centralParts.push(concatBytes(
        uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(dosTime), uint16(dosDate),
        uint32(checksum), uint32(bytes.length), uint32(bytes.length), uint16(name.length), uint16(0), uint16(0),
        uint16(0), uint16(0), uint32(0), uint32(offset), name,
      ));
      offset += localFile.length;
    });
    const localData = concatBytes(...localParts);
    const centralData = concatBytes(...centralParts);
    const end = concatBytes(
      uint32(0x06054b50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
      uint32(centralData.length), uint32(localData.length), uint16(0),
    );
    return concatBytes(localData, centralData, end);
  }

  function uint16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    return bytes;
  }

  function uint32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
  }

  function concatBytes(...parts) {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => {
      result.set(part, offset);
      offset += part.length;
    });
    return result;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function element(tag, text = '', className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
  }

  function isSafeHttpUrl(value) {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }

  function safeFragmentId(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function showToast(root, message, isError = false) {
    const toast = root.querySelector('[data-usl-toast]');
    clearTimeout(root.__uslToastTimer);
    toast.textContent = message;
    toast.className = `usl-toast${isError ? ' is-error' : ''}`;
    toast.hidden = false;
    root.__uslToastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
  }

  function showFatal(root, error) {
    const host = root.querySelector('[data-usl-modules]');
    const state = root.querySelector('[data-usl-data-state]');
    if (state) state.replaceChildren(element('strong', '数据载入失败'), element('small', '请重新构建网页数据'));
    if (host) host.replaceChildren(element('div', `美元流动性看板无法显示，${safeErrorMessage(error)}`, 'usl-fatal'));
  }

  function safeErrorMessage(error) {
    return error instanceof Error ? error.message : String(error || '未知错误');
  }
})();
