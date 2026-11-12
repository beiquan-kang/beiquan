(() => {
const clientChartWidth = 1320;
  const clientMargin = { top: 18, right: 20, bottom: 38, left: 64 };
  const clientPlotRight = clientChartWidth - clientMargin.right;
  const clientInnerWidth = clientPlotRight - clientMargin.left;
  const clientSpreadHeight = 236;
  const svgNamespace = 'http://www.w3.org/2000/svg';

  function clientTimestamp(value) {
    return Date.parse(`${value}T00:00:00Z`);
  }

  function clientDate(value) {
    const date = new Date(value);
    return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
  }

  function clientShortDate(value) {
    const date = new Date(value);
    return `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function clientShiftYears(value, years) {
    const date = new Date(value);
    return Date.UTC(
      date.getUTCFullYear() + years,
      date.getUTCMonth(),
      date.getUTCDate(),
    );
  }

  function clientNiceStep(value) {
    const exponent = Math.floor(Math.log10(value));
    const magnitude = 10 ** exponent;
    const fraction = value / magnitude;
    const niceFraction = fraction <= 1
      ? 1
      : fraction <= 2
        ? 2
        : fraction <= 2.5
          ? 2.5
          : fraction <= 5
            ? 5
            : 10;
    return niceFraction * magnitude;
  }

  function clientMakeScale(values, includeZero = false) {
    let rawMin = Math.min(...values);
    let rawMax = Math.max(...values);
    if (includeZero) {
      rawMin = Math.min(0, rawMin);
      rawMax = Math.max(0, rawMax);
    }
    if (rawMin === rawMax) {
      const padding = Math.max(Math.abs(rawMin) * 0.08, includeZero ? 10 : 0.25);
      rawMin -= padding;
      rawMax += padding;
    }
    const padding = (rawMax - rawMin) * 0.07;
    rawMin -= padding;
    rawMax += padding;
    if (includeZero) {
      rawMin = Math.min(0, rawMin);
      rawMax = Math.max(0, rawMax);
    }
    const step = clientNiceStep((rawMax - rawMin) / 5);
    const min = Math.floor(rawMin / step) * step;
    const max = Math.ceil(rawMax / step) * step;
    const ticks = [];
    const tickCount = Math.round((max - min) / step);
    for (let index = 0; index <= tickCount; index += 1) {
      ticks.push(Number((min + index * step).toFixed(10)));
    }
    return { min, max, step, ticks };
  }

  function clientDateTicks(start, end) {
    const durationYears = (end - start) / (365.25 * 24 * 60 * 60 * 1000);
    const monthStep = durationYears <= 1.25
      ? 3
      : durationYears <= 3.5
        ? 6
        : durationYears <= 6
          ? 12
          : durationYears <= 12
            ? 24
            : 36;
    const ticks = [start];
    const startDate = new Date(start);
    const startMonthIndex = startDate.getUTCFullYear() * 12 + startDate.getUTCMonth();
    let alignedMonthIndex = Math.floor(startMonthIndex / monthStep) * monthStep + monthStep;
    while (true) {
      const year = Math.floor(alignedMonthIndex / 12);
      const month = alignedMonthIndex % 12;
      const value = Date.UTC(year, month, 1);
      if (value >= end) break;
      if ((value - start) / (end - start) >= 0.075) ticks.push(value);
      alignedMonthIndex += monthStep;
    }
    if ((end - ticks.at(-1)) / (end - start) < 0.075) ticks.pop();
    ticks.push(end);
    return ticks;
  }

  function clientSpreadAxis(value) {
    return `${Math.round(value)}bp`;
  }

  function clientFormatYield(value) {
    return `${value.toFixed(2)}%`;
  }

  function clientFormatSpread(value) {
    const normalized = Math.abs(value) < 0.05 ? 0 : value;
    return `${normalized > 0 ? '+' : ''}${normalized.toFixed(1)}bp`;
  }

  function svgElement(name) {
    return document.createElementNS(svgNamespace, name);
  }

  function getChartElements(root, kind) {
    const article = root.querySelector(`[data-rate-chart="${kind}"]`);
    const body = article?.querySelector('.us-rate-chart-body');
    const svg = article?.querySelector(`[data-rate-svg="${kind}"]`);
    const yAxis = svg?.querySelector('[data-rate-y-axis]');
    const xAxis = svg?.querySelector('[data-rate-x-axis]');
    const guide = svg?.querySelector('[data-rate-hover-guide]');
    const markers = svg?.querySelector('[data-rate-hover-markers]');
    const tooltip = article?.querySelector('[data-rate-tooltip]');
    const hit = svg?.querySelector('[data-rate-plot-hit]');
    if (!article || !body || !svg || !yAxis || !xAxis || !guide || !markers || !tooltip || !hit) {
      return null;
    }
    return { article, body, svg, yAxis, xAxis, guide, markers, tooltip, hit };
  }

  function renderYAxis(group, scale, height, formatter) {
    const plotBottom = height - clientMargin.bottom;
    const innerHeight = plotBottom - clientMargin.top;
    const yPosition = (value) => clientMargin.top
      + (scale.max - value) / (scale.max - scale.min) * innerHeight;
    const nodes = scale.ticks.map((tick) => {
      const wrapper = svgElement('g');
      const line = svgElement('line');
      const text = svgElement('text');
      const y = yPosition(tick);
      line.setAttribute('x1', String(clientMargin.left));
      line.setAttribute('y1', String(y));
      line.setAttribute('x2', String(clientPlotRight));
      line.setAttribute('y2', String(y));
      text.setAttribute('x', String(clientMargin.left - 10));
      text.setAttribute('y', String(y + 3.5));
      text.setAttribute('text-anchor', 'end');
      text.textContent = formatter(tick, scale.step);
      wrapper.append(line, text);
      return wrapper;
    });
    group.replaceChildren(...nodes);
  }

  function renderXAxis(group, start, end, height) {
    const plotBottom = height - clientMargin.bottom;
    const ticks = clientDateTicks(start, end);
    const xPosition = (value) => clientMargin.left
      + (value - start) / (end - start) * clientInnerWidth;
    const nodes = ticks.map((tick, index) => {
      const wrapper = svgElement('g');
      const line = svgElement('line');
      const text = svgElement('text');
      const x = xPosition(tick);
      line.setAttribute('x1', String(x));
      line.setAttribute('y1', String(plotBottom));
      line.setAttribute('x2', String(x));
      line.setAttribute('y2', String(plotBottom + 4));
      text.setAttribute('x', String(x));
      text.setAttribute('y', String(height - 14));
      text.setAttribute('text-anchor', index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle');
      text.textContent = clientShortDate(tick);
      wrapper.append(line, text);
      return wrapper;
    });
    group.replaceChildren(...nodes);
  }

  function initializeUsRateCharts() {
    document.querySelectorAll('[data-us-rate-charts]').forEach((root) => {
      if (root.dataset.usRateReady === 'true') return;
      const payloadNode = root.querySelector('[data-us-rate-payload]');
      const spreadChart = getChartElements(root, 'spread');
      if (!payloadNode?.textContent || !spreadChart) return;

      let payload;
      try {
        payload = JSON.parse(payloadNode.textContent);
      } catch {
        return;
      }

      const anchor = clientTimestamp(payload.anchorDate);
      const allTimestamps = [
        ...payload.spread.map((point) => clientTimestamp(point.date)),
      ];
      const allStart = Math.min(...allTimestamps);
      let domainStart = clientShiftYears(anchor, -3);
      let spreadScale = clientMakeScale([-1, 1], true);
      let spreadMap = new Map();
      let hoverTimestamps = [];

      const xPosition = (value) => clientMargin.left
        + (value - domainStart) / (anchor - domainStart) * clientInnerWidth;
      const spreadY = (value) => clientMargin.top
        + (spreadScale.max - value) / (spreadScale.max - spreadScale.min)
          * (clientSpreadHeight - clientMargin.bottom - clientMargin.top);

      function segmentClientPoints(points) {
        return points.reduce((segments, point) => {
          const current = segments.at(-1);
          const previous = current?.at(-1);
          const gap = previous
            ? clientTimestamp(point.date) - clientTimestamp(previous.date)
            : Number.POSITIVE_INFINITY;
          if (!current || gap > 5 * 24 * 60 * 60 * 1000) {
            segments.push([point]);
          } else {
            current.push(point);
          }
          return segments;
        }, []);
      }

      function segmentLinePath(points, yPosition) {
        return points.map((point, index) => (
          `${index === 0 ? 'M' : 'L'}${xPosition(clientTimestamp(point.date)).toFixed(2)},${yPosition(point.value).toFixed(2)}`
        )).join(' ');
      }

      function linePath(points, yPosition) {
        return segmentClientPoints(points)
          .map((segment) => segmentLinePath(segment, yPosition))
          .join(' ');
      }

      function areaPathForPoints(points, yPosition, baselineY) {
        return segmentClientPoints(points).map((segment) => {
          const firstX = xPosition(clientTimestamp(segment[0].date));
          const lastX = xPosition(clientTimestamp(segment.at(-1).date));
          return `${segmentLinePath(segment, yPosition)} L${lastX.toFixed(2)},${baselineY.toFixed(2)} L${firstX.toFixed(2)},${baselineY.toFixed(2)} Z`;
        }).join(' ');
      }

      function hideHover() {
        [spreadChart].forEach((chart) => {
          chart.guide.style.opacity = '0';
          chart.markers.style.opacity = '0';
          chart.tooltip.hidden = true;
        });
      }

      function redraw(range) {
        domainStart = range === 'all'
          ? allStart
          : clientShiftYears(anchor, -Number(range));
        const visibleSpread = payload.spread.filter((point) => {
          const value = clientTimestamp(point.date);
          return value >= domainStart && value <= anchor;
        });
        if (visibleSpread.length === 0) return;

        spreadScale = clientMakeScale(visibleSpread.map((point) => point.value), true);
        renderYAxis(spreadChart.yAxis, spreadScale, clientSpreadHeight, (value) => clientSpreadAxis(value));
        renderXAxis(spreadChart.xAxis, domainStart, anchor, clientSpreadHeight);

        const spreadPath = linePath(visibleSpread, spreadY);
        const zeroY = spreadY(0);
        const areaPath = areaPathForPoints(visibleSpread, spreadY, zeroY);
        spreadChart.svg.querySelector('[data-rate-spread-line]')?.setAttribute('d', spreadPath);
        spreadChart.svg.querySelectorAll('[data-rate-spread-area]').forEach((path) => {
          path.setAttribute('d', areaPath);
        });
        const zeroLine = spreadChart.svg.querySelector('[data-rate-zero-line]');
        zeroLine?.setAttribute('y1', String(zeroY));
        zeroLine?.setAttribute('y2', String(zeroY));
        const positiveClip = spreadChart.svg.querySelector('[data-rate-positive-clip]');
        positiveClip?.setAttribute('y', String(clientMargin.top));
        positiveClip?.setAttribute('height', String(Math.max(0, zeroY - clientMargin.top)));
        const negativeClip = spreadChart.svg.querySelector('[data-rate-negative-clip]');
        negativeClip?.setAttribute('y', String(zeroY));
        negativeClip?.setAttribute('height', String(Math.max(0, clientSpreadHeight - clientMargin.bottom - zeroY)));

        spreadMap = new Map(visibleSpread.map((point) => [point.date, point]));
        hoverTimestamps = visibleSpread
          .map((point) => clientTimestamp(point.date));
        if (hoverTimestamps.length === 0) {
          hoverTimestamps = visibleSpread.map((point) => clientTimestamp(point.date));
        }
        root.querySelectorAll('[data-rate-range]').forEach((button) => {
          button.setAttribute('aria-pressed', String(button.dataset.rateRange === range));
        });
        hideHover();
      }

      function nearestHoverTimestamp(target) {
        let low = 0;
        let high = hoverTimestamps.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (hoverTimestamps[middle] < target) low = middle + 1;
          else high = middle;
        }
        if (low === 0) return hoverTimestamps[0];
        const previous = hoverTimestamps[low - 1];
        const current = hoverTimestamps[low];
        return Math.abs(current - target) < Math.abs(target - previous) ? current : previous;
      }

      function positionTooltip(chart, localX) {
        const svgRect = chart.svg.getBoundingClientRect();
        const bodyRect = chart.body.getBoundingClientRect();
        const pixelX = svgRect.left - bodyRect.left + localX / clientChartWidth * svgRect.width;
        chart.tooltip.hidden = false;
        const tooltipWidth = chart.tooltip.getBoundingClientRect().width;
        chart.tooltip.style.left = `${Math.max(8, Math.min(bodyRect.width - tooltipWidth - 8, pixelX + 10))}px`;
        chart.tooltip.style.top = '8px';
      }

      function showHover(value) {
        const date = new Date(value).toISOString().slice(0, 10);
        const spreadPoint = spreadMap.get(date);
        if (!spreadPoint) return;
        const x = xPosition(value);

        [spreadChart].forEach((chart) => {
          chart.guide.setAttribute('x1', String(x));
          chart.guide.setAttribute('x2', String(x));
          chart.guide.style.opacity = '1';
          chart.markers.style.opacity = '1';
        });
        const spreadMarker = spreadChart.markers.querySelector('[data-rate-marker="spread"]');
        spreadMarker?.setAttribute('cx', String(x));
        spreadMarker?.setAttribute('cy', String(spreadY(spreadPoint.value)));

        spreadChart.tooltip.textContent = [
          clientDate(value),
          `利差  ${clientFormatSpread(spreadPoint.value)}`,
          `美国10年期  ${clientFormatYield(spreadPoint.us10y)}`,
          `中国10年期  ${clientFormatYield(spreadPoint.cn10y)}`,
        ].join('\n');
        positionTooltip(spreadChart, x);
      }

      function handlePointer(event, chart) {
        const matrix = chart.svg.getScreenCTM();
        if (!matrix || hoverTimestamps.length === 0) return;
        const point = chart.svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const local = point.matrixTransform(matrix.inverse());
        const boundedX = Math.max(clientMargin.left, Math.min(clientPlotRight, local.x));
        const target = domainStart
          + (boundedX - clientMargin.left) / clientInnerWidth * (anchor - domainStart);
        showHover(nearestHoverTimestamp(target));
      }

      root.querySelectorAll('[data-rate-range]').forEach((button) => {
        button.addEventListener('click', () => redraw(button.dataset.rateRange ?? '3'));
      });
      [spreadChart].forEach((chart) => {
        chart.hit.addEventListener('pointermove', (event) => handlePointer(event, chart));
        chart.hit.addEventListener('pointerdown', (event) => handlePointer(event, chart));
      });
      root.addEventListener('pointerleave', hideHover);
      redraw('3');
      root.dataset.usRateReady = 'true';
    });
  }

  initializeUsRateCharts();
  document.addEventListener('astro:page-load', initializeUsRateCharts);
})();
