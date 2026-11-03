const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderRateChart(data, message) {
  if (!data?.spread?.points?.length) {
    return `<section class="usl-indicator us-rate-section" data-us-rate-charts data-indicator-id="us_cn_10y_spread">
      <h3>中美10年期国债利差</h3><p class="us-rate-warning">${escape(message || 'Choice 尚未启用，中美利差暂缺。')}</p>
      <p class="us-rate-source">口径为美国10年期减中国10年期，使用同日实际观察值，单位为bp。</p></section>`;
  }
  const latest = data.spread.points.at(-1);
  const formatted = `${latest.value > 0 ? '+' : ''}${latest.value.toFixed(1)}bp`;
  const buttons = [['1', '1年'], ['3', '3年'], ['5', '5年'], ['10', '10年'], ['all', '全部']]
    .map(([value, label]) => `<button type="button" data-rate-range="${value}" aria-pressed="${value === '3'}">${label}</button>`).join('');
  const payload = JSON.stringify({ anchorDate: data.spreadAsOf, spread: data.spread.points }).replaceAll('<', '\\u003c');
  return `<section class="usl-indicator us-rate-section" data-us-rate-charts data-indicator-id="us_cn_10y_spread" aria-labelledby="us-cn-spread-title">
    <div class="us-rate-content"><div class="us-rate-chart-stack"><article class="us-rate-panel" data-rate-chart="spread">
      <header class="us-rate-panel-head"><div><h3 id="us-cn-spread-title">中美10年期国债利差</h3>
        <time datetime="${escape(data.spreadAsOf)}">美国10年期减中国10年期，截至 ${escape(data.spreadAsOf)}</time></div>
        <div class="us-rate-current"><span>当前</span><b class="${latest.value < 0 ? 'is-negative' : ''}">${formatted}</b></div></header>
      <div class="us-rate-toolbar"><span>观察窗口</span><div class="us-rate-range" role="group" aria-label="选择利率图观察窗口">${buttons}</div></div>
      <div class="us-rate-chart-body"><svg viewBox="0 0 1320 236" role="img" aria-labelledby="us-cn-spread-title" data-rate-svg="spread">
        <defs><clipPath id="us-rate-positive-clip" clipPathUnits="userSpaceOnUse"><rect data-rate-positive-clip x="64" y="18" width="1236" height="90"/></clipPath>
          <clipPath id="us-rate-negative-clip" clipPathUnits="userSpaceOnUse"><rect data-rate-negative-clip x="64" y="108" width="1236" height="90"/></clipPath></defs>
        <g class="us-rate-y-axis" data-rate-y-axis></g>
        <path class="us-rate-spread-area us-rate-spread-area--positive" data-rate-spread-area="positive" clip-path="url(#us-rate-positive-clip)"/>
        <path class="us-rate-spread-area us-rate-spread-area--negative" data-rate-spread-area="negative" clip-path="url(#us-rate-negative-clip)"/>
        <line class="us-rate-zero-line" data-rate-zero-line x1="64" y1="108" x2="1300" y2="108"/>
        <path class="us-rate-line us-rate-spread-line" data-rate-spread-line fill="none"/>
        <g class="us-rate-x-axis" data-rate-x-axis></g>
        <line class="us-rate-hover-guide" data-rate-hover-guide x1="64" y1="18" x2="64" y2="198"/>
        <g class="us-rate-hover-markers" data-rate-hover-markers><circle data-rate-marker="spread" cx="64" cy="18" r="3.5"/></g>
        <rect class="us-rate-plot-hit" data-rate-plot-hit x="64" y="18" width="1236" height="180"/>
      </svg><div class="us-rate-tooltip" data-rate-tooltip role="status" aria-live="polite" hidden></div></div>
      </article></div><footer class="us-rate-source">
        <p>数据来源　${escape(data.source.provider)}，中国10年期采用${escape(data.source.series.cn10y)}口径。</p>
        <p>${escape(data.alignmentMethod)}</p>
        ${message ? `<p class="us-rate-warning">${escape(message)}</p>` : ''}
        ${data.warnings.map((warning) => `<p class="us-rate-warning">数据提示　${escape(warning)}</p>`).join('')}
      </footer></div><script type="application/json" data-us-rate-payload>${payload}</script></section>`;
}
