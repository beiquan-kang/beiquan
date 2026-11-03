'use strict';

function buildRefreshAudit(indicators, previousSnapshot, requestedDate) {
  const previousById = new Map((previousSnapshot?.modules ?? [])
    .flatMap((module) => module.indicators ?? [])
    .map((indicator) => [indicator.id, indicator]));
  const rows = Object.values(indicators).map((indicator) => {
    const prior = previousById.get(indicator.id);
    const priorHistory = (prior?.history ?? []).filter((point) => point.date <= requestedDate);
    const previous = priorHistory.at(-1);
    const observationDate = indicator.observationDate ?? null;
    const newObservationCount = (indicator.history ?? []).filter((point) => (
      point.date <= requestedDate && (!previous || point.date > previous.date)
    )).length;
    return {
      id: indicator.id,
      frequency: indicator.frequency,
      observationDate,
      previousObservationDate: previous?.date ?? null,
      newObservationCount,
      latestValueChanged: Boolean(previous && indicator.value !== previous.value),
      retainedPreviousValue: Boolean(indicator.retainedPreviousValue),
      refreshState: indicator.status === 'missing' ? 'unavailable' : indicator.retainedPreviousValue ? 'not_updated' : newObservationCount > 0 ? 'advanced' : 'unchanged',
      status: indicator.status,
      regressed: Boolean(previous && observationDate && observationDate < previous.date
        && !indicator.retainedPreviousValue),
    };
  });
  return {
    advancedIndicatorCount: rows.filter((row) => row.newObservationCount > 0).length,
    unchangedObservationCount: rows.filter((row) => row.refreshState === 'unchanged').length,
    notUpdatedIndicatorCount: rows.filter((row) => row.refreshState === 'not_updated').length,
    unavailableIndicatorCount: rows.filter((row) => row.refreshState === 'unavailable').length,
    regressedIndicatorIds: rows.filter((row) => row.regressed).map((row) => row.id),
    indicators: rows,
  };
}

module.exports = { buildRefreshAudit };
