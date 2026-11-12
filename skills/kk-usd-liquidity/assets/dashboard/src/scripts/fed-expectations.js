(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const colors = ['#bd6519', '#2758b3', '#438c70', '#9673b2', '#627383', '#be5778'];
  const dateTime = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
  const shortDate = (value) => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }).format(new Date(value));
  const node = (tag, text = '', className = '') => {
    const item = document.createElement(tag);
    item.textContent = text;
    item.className = className;
    return item;
  };
  const svgNode = (tag, attrs, text = '') => {
    const item = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => item.setAttribute(key, String(value)));
    item.textContent = text;
    return item;
  };
  const link = (text, href) => {
    const item = node('a', text);
    if (/^https:\/\//.test(href || '')) { item.href = href; item.target = '_blank'; item.rel = 'noopener noreferrer'; }
    return item;
  };
  const percent = (value) => typeof value === 'number' && Number.isFinite(value) ? value > 0 && value < 0.01 ? '<0.01%' : `${value.toFixed(value > 0 && value < 1 ? 2 : 1)}%` : '暂无报价';
  const delta = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(1)}个百分点` : '待积累';

  globalThis.__renderFedExpectations = (host) => {
    const data = globalThis.__FED_EXPECTATIONS__;
    const section = node('section', '', 'fed-expectations');
    section.setAttribute('aria-label', '下一次美联储议息概率');
    const heading = node('div', '', 'fed-heading');
    heading.append(node('h4', '下一次美联储议息概率'));
    section.append(heading);
    host.append(section);
    if (!data?.meeting || !data.outcomes?.length) {
      section.append(node('p', '议息概率暂不可用，等待下一次数据更新。', 'fed-note'));
      if (data?.meta?.generatedAt) section.append(node('p', `最近读取 ${dateTime(data.meta.generatedAt)} 北京时间`, 'fed-note'));
      if (data?.meta?.errors?.length) section.append(node('p', data.meta.errors.join('；'), 'fed-warning'));
      renderCalendar(section, data?.calendar);
      return;
    }
    const meeting = data.meeting;
    if (meeting.decisionAt && Date.parse(meeting.decisionAt) <= Date.now()) heading.firstChild.textContent = '美联储议息概率快照';
    heading.append(link('Polymarket 原始市场 ↗', meeting.sourceUrl));
    const timing = meeting.decisionAt ? `决议时间 ${dateTime(meeting.decisionAt)} 北京时间` : `会议日期 ${meeting.meetingDate || '待核验'}，决议时间待核验`;
    section.append(node('p', timing, 'fed-timing'));
    const meta = data.meta || {};
    const updated = meta.generatedAt ? `读取于 ${dateTime(meta.generatedAt)} 北京时间` : '读取时间缺失';
    section.append(node('p', `${updated} · 交易隐含概率，不代表美联储官方预测`, 'fed-note'));
    if (Date.now() - Date.parse(meta.generatedAt) > 36 * 3600000) section.append(node('p', '概率读取已超过36小时，等待重新更新。', 'fed-warning'));
    if (meeting.decisionAt && Date.parse(meeting.decisionAt) <= Date.now()) section.append(node('p', '本次决议时间已到，当前保留更新时的概率，下一次更新将重新匹配会议。', 'fed-warning'));
    if (data.switchedFromEventId) section.append(node('p', '已切换至下一次会议，概率变化从本会议重新累计。', 'fed-note'));
    const outcomes = data.outcomes.map((outcome, index) => ({ ...outcome, color: colors[index % colors.length], history: (outcome.history || []).map(([time, probability]) => ({ time: Date.parse(time), probability })).filter((point) => Number.isFinite(point.time) && Number.isFinite(point.probability)).sort((a, b) => a.time - b.time) }));
    const selected = new Set(outcomes.map((outcome) => outcome.marketId));
    const cards = node('div', '', 'fed-outcomes');
    const plot = node('div', '', 'fed-plot');
    const readout = node('div', '移动到曲线上查看历史概率，时间均为北京时间', 'fed-readout');
    readout.setAttribute('role', 'status');
    const switches = [];
    outcomes.forEach((outcome) => {
      const button = node('button', '', `fed-outcome${outcome.direction === 'hike' ? ' is-hike' : ''}`);
      button.type = 'button';
      button.style.setProperty('--fed-series', outcome.color);
      button.setAttribute('aria-pressed', 'true');
      button.append(node('span', outcome.label, 'fed-outcome-label'), node('strong', percent(outcome.probability)), node('small', `24小时 ${delta(outcome.change24hPp)} · 7天 ${delta(outcome.change7dPp)}`));
      const priceMethod = ({ clob_midpoint: '买卖中间价', clob_last_trade: '最近成交价', gamma_outcome_price: '来源参考报价' })[outcome.priceMethod] || '报价口径暂缺';
      button.title = `${priceMethod}${outcome.quoteAt ? ` · 报价时间 ${dateTime(outcome.quoteAt)} 北京时间` : ''} · 点击显示或隐藏历史曲线`;
      button.addEventListener('click', () => {
        if (selected.has(outcome.marketId)) { if (selected.size === 1) return; selected.delete(outcome.marketId); }
        else selected.add(outcome.marketId);
        button.setAttribute('aria-pressed', String(selected.has(outcome.marketId)));
        redraw();
      });
      cards.append(button);
    });
    section.append(cards);
    const toolbar = node('div', '', 'fed-toolbar');
    toolbar.append(node('span', '各选项概率走势'));
    let range = 30;
    for (const [days, label] of [[7, '近7天'], [30, '近30天'], [0, '已采集历史']]) {
      const button = node('button', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(days === range));
      button.addEventListener('click', () => { range = days; switches.forEach(([d, b]) => b.setAttribute('aria-pressed', String(d === days))); redraw(); });
      switches.push([days, button]);
      toolbar.append(button);
    }
    section.append(toolbar, plot, readout);
    function redraw() {
      const shown = outcomes.filter((outcome) => selected.has(outcome.marketId));
      const allPoints = outcomes.flatMap((outcome) => outcome.history);
      plot.replaceChildren();
      if (!shown.some((outcome) => outcome.history.length)) { plot.append(node('p', '该选项暂无可核验的历史曲线，当前概率见上方。', 'fed-empty')); return; }
      const end = Date.parse(meta.generatedAt);
      const first = Math.min(...allPoints.map((point) => point.time));
      const start = range ? Math.max(first, end - range * 86400000) : first;
      const width = Math.max(340, Math.min(1100, plot.clientWidth || 1100)), height = 270, left = 47, right = 16, top = 15, bottom = 30;
      const x = (time) => left + (time - start) / Math.max(1, end - start) * (width - left - right);
      const y = (probability) => top + (100 - probability) / 100 * (height - top - bottom);
      const svg = svgNode('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '各议息选项的历史隐含概率，纵轴百分比', tabindex: '0' });
      [0, 25, 50, 75, 100].forEach((p) => {
        svg.append(svgNode('line', { x1: left, x2: width - right, y1: y(p), y2: y(p), stroke: '#dfe4e8', 'stroke-width': 1 }));
        svg.append(svgNode('text', { x: left - 9, y: y(p) + 4, 'text-anchor': 'end', fill: '#76818a', 'font-size': 11 }, `${p}%`));
      });
      for (let i = 0; i < 5; i++) {
        const time = start + (end - start) * i / 4;
        svg.append(svgNode('text', { x: x(time), y: height - 7, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', fill: '#76818a', 'font-size': 11 }, shortDate(time)));
      }
      const series = shown.map((outcome) => ({ ...outcome, points: outcome.history.filter((p) => p.time >= start && p.time <= end) }));
      if (!series.some((outcome) => outcome.points.length)) { plot.append(node('p', '所选时间内暂无历史观测，缺失区间不补值。', 'fed-empty')); return; }
      series.forEach((outcome) => {
        const d = outcome.points.map((point, index) => `${index === 0 || point.time - outcome.points[index - 1].time > 6 * 3600000 ? 'M' : 'L'}${x(point.time).toFixed(2)},${y(point.probability).toFixed(2)}`).join(' ');
        svg.append(svgNode('path', { d, stroke: outcome.color, fill: 'none', 'stroke-width': outcome.direction === 'hike' ? 2.6 : 1.8, 'vector-effect': 'non-scaling-stroke' }));
        outcome.points.forEach((point, index) => {
          const previous = outcome.points[index - 1], next = outcome.points[index + 1];
          if ((!previous || point.time - previous.time > 6 * 3600000) && (!next || next.time - point.time > 6 * 3600000)) {
            svg.append(svgNode('circle', { cx: x(point.time), cy: y(point.probability), r: 3, fill: outcome.color }));
          }
        });
      });
      const guide = svgNode('line', { x1: left, x2: left, y1: top, y2: height - bottom, stroke: '#9aa7b2', 'stroke-dasharray': '3 3', visibility: 'hidden' });
      svg.append(guide);
      const timeline = [...new Set(series.flatMap((outcome) => outcome.points.map((p) => p.time)))].sort((a, b) => a - b);
      let index = Math.max(0, timeline.length - 1);
      const show = (time) => {
        guide.setAttribute('x1', String(x(time))); guide.setAttribute('x2', String(x(time))); guide.setAttribute('visibility', 'visible');
        readout.textContent = `${dateTime(time)}  ${series.map((outcome) => {
          const point = outcome.points.reduce((best, p) => !best || Math.abs(p.time - time) < Math.abs(best.time - time) ? p : best, null);
          return `${outcome.label} ${point && Math.abs(point.time - time) <= 90 * 60000 ? percent(point.probability) : '暂无同期观测'}`;
        }).join(' · ')}`;
      };
      svg.addEventListener('pointermove', (event) => {
        const bounds = svg.getBoundingClientRect();
        const target = start + Math.max(0, Math.min(1, ((event.clientX - bounds.left) / bounds.width * width - left) / (width - left - right))) * (end - start);
        const time = timeline.reduce((best, t) => Math.abs(t - target) < Math.abs(best - target) ? t : best, timeline[0]);
        if (time) show(time);
      });
      svg.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !timeline.length) return;
        event.preventDefault();
        index = event.key === 'Home' ? 0 : event.key === 'End' ? timeline.length - 1 : Math.max(0, Math.min(timeline.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
        show(timeline[index]);
      });
      plot.append(svg);
    }
    redraw();
    if (typeof ResizeObserver !== 'undefined') {
      let lastWidth = 0;
      new ResizeObserver(([entry]) => {
        const width = Math.round(entry.contentRect.width);
        if (width > 0 && width !== lastWidth) { lastWidth = width; redraw(); }
      }).observe(plot);
    }
    section.append(node('p', meta.historyMethod || '历史曲线来自 Polymarket CLOB，当前报价与历史序列口径分别保存。概率变化只比较同一会议与同一报价口径，历史不足时留空。', 'fed-note'));
    const sources = node('p', '', 'fed-note');
    sources.append(link('概率数据与规则', meeting.sourceUrl), document.createTextNode(' · '), link('美联储会议日历', 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'));
    section.append(sources);
    if (meta.warnings?.length) section.append(node('p', meta.warnings.join('；'), 'fed-warning'));
    renderCalendar(section, data.calendar);
  };

  function renderCalendar(section, calendar) {
    const wrap = node('div', '', 'fed-calendar');
    wrap.append(node('h5', '近期关注事件 · 北京时间'));
    const events = (calendar?.events || []).filter((event) => Date.parse(event.startsAt) > Date.now() && (!event.expiresAt || Date.parse(event.expiresAt) > Date.now())).slice(0, 10);
    if (!events.length) wrap.append(node('p', '暂未取得可核验的近期日程，下一次更新时重试。', 'fed-note'));
    else {
      const list = node('div', '', 'fed-event-list');
      events.forEach((event) => {
        const row = node('div', '', 'fed-event');
        row.append(node('time', dateTime(event.startsAt)), link(event.title, event.sourceUrl));
        list.append(row);
      });
      wrap.append(list);
      const cached = events.find((event) => event.sourceMode === 'verified-cache');
      if (cached) wrap.append(node('p', `CPI、非农等BLS排期于${dateTime(cached.verifiedAt)}北京时间核验，有效至${dateTime(cached.expiresAt)}。官网暂无法直连，过期未复核的条目停止展示。`, 'fed-note'));
      if (calendar.status !== 'ok') wrap.append(node('p', '部分官方日历暂不可用，当前仅显示已核验日程。', 'fed-note'));
    }
    section.append(wrap);
  }
})();
