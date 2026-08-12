/**
 * Durable, user-scoped shadow-observation state.
 *
 * This module deliberately contains no Firebase or filesystem access so both
 * Cloud Functions and unit tests can use the exact same idempotent rules.
 */

const MAX_OBSERVATIONS = 120;

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function normalizeDate(value) {
  const text = String(value || "").replace(/\//g, "-");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function sortedNavRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter(function(row) {
    return row && normalizeDate(row.date) && Number(row.nav) > 0;
  }).slice().sort(function(left, right) {
    return String(left.date).localeCompare(String(right.date));
  });
}

function followUpReturn(rows, asOf, tradingDays) {
  const navs = sortedNavRows(rows);
  const index = navs.findIndex(function(row) { return row.date === asOf; });
  if (index < 0 || !navs[index + tradingDays]) return null;
  const start = Number(navs[index].nav);
  const end = Number(navs[index + tradingDays].nav);
  return start > 0 ? round2((end / start - 1) * 100) : null;
}

function cloneCandidate(candidate) {
  return {
    code: String((candidate && candidate.code) || ""),
    name: String((candidate && candidate.name) || ""),
    indexGroup: String((candidate && candidate.indexGroup) || ""),
    marketScore: Number.isFinite(Number(candidate && candidate.marketScore)) ? Number(candidate.marketScore) : null,
    followUp5dReturn: candidate && candidate.followUp5dReturn !== undefined ? candidate.followUp5dReturn : null,
    followUp10dReturn: candidate && candidate.followUp10dReturn !== undefined ? candidate.followUp10dReturn : null
  };
}

function observationFromPlan(plan, generatedAt) {
  const source = plan || {};
  const date = normalizeDate(source.asOf || source.date);
  if (!date) throw new Error("INVALID_PLAN_DATE");
  const ranked = (source.candidates || []).map(cloneCandidate).filter(function(candidate) {
    return candidate.code;
  });
  return {
    date: date,
    strategyVersion: String(source.strategyVersion || "allocation-v2.4-monthly-alpha-gate"),
    action: String(source.action || "PAUSE"),
    generatedAt: String(generatedAt || new Date().toISOString()),
    ranked: ranked
  };
}

function mergeSameDay(previous, next) {
  const priorByCode = new Map(((previous && previous.ranked) || []).map(function(candidate) {
    return [candidate.code, candidate];
  }));
  const ranked = next.ranked.map(function(candidate) {
    const prior = priorByCode.get(candidate.code);
    return Object.assign({}, candidate, {
      followUp5dReturn: prior && prior.followUp5dReturn !== null && prior.followUp5dReturn !== undefined
        ? prior.followUp5dReturn : candidate.followUp5dReturn,
      followUp10dReturn: prior && prior.followUp10dReturn !== null && prior.followUp10dReturn !== undefined
        ? prior.followUp10dReturn : candidate.followUp10dReturn
    });
  });
  return Object.assign({}, next, { ranked: ranked });
}

function backfillObservation(observation, navCache) {
  const changed = Object.assign({}, observation, { ranked: ((observation && observation.ranked) || []).map(function(candidate) {
    const next = Object.assign({}, candidate);
    const rows = navCache && navCache[next.code];
    if (next.followUp5dReturn === null || next.followUp5dReturn === undefined) {
      const value5d = followUpReturn(rows, observation.date, 5);
      if (value5d !== null) next.followUp5dReturn = value5d;
    }
    if (next.followUp10dReturn === null || next.followUp10dReturn === undefined) {
      const value10d = followUpReturn(rows, observation.date, 10);
      if (value10d !== null) next.followUp10dReturn = value10d;
    }
    return next;
  }) });
  return changed;
}

function summaryFor(observations) {
  const values = [];
  const dates = new Set();
  (observations || []).forEach(function(observation) {
    ((observation && observation.ranked) || []).forEach(function(candidate) {
      if (candidate.followUp5dReturn !== null && candidate.followUp5dReturn !== undefined &&
          Number.isFinite(Number(candidate.followUp5dReturn))) {
        values.push(Number(candidate.followUp5dReturn));
        dates.add(observation.date);
      }
    });
  });
  const wins = values.filter(function(value) { return value > 0; }).length;
  return {
    completed5dResults: values.length,
    positive5dResults: wins,
    winRate: values.length ? round2(wins / values.length * 100) : null,
    average5dReturn: values.length ? round2(values.reduce(function(sum, value) { return sum + value; }, 0) / values.length) : null,
    observedDatesWithResults: dates.size
  };
}

function advanceState(existing, plan, navCache, generatedAt) {
  const previous = existing || {};
  const nextObservation = observationFromPlan(plan, generatedAt);
  const byDate = new Map(((previous.observations || [])).filter(function(observation) {
    return observation && normalizeDate(observation.date);
  }).map(function(observation) { return [observation.date, observation]; }));
  byDate.set(nextObservation.date, mergeSameDay(byDate.get(nextObservation.date), nextObservation));
  const observations = Array.from(byDate.values()).sort(function(left, right) {
    return left.date.localeCompare(right.date);
  }).slice(-MAX_OBSERVATIONS).map(function(observation) {
    return backfillObservation(observation, navCache || {});
  });
  return {
    schemaVersion: 1,
    updatedAt: String(generatedAt || new Date().toISOString()),
    latestPlan: plan,
    observations: observations,
    summary: summaryFor(observations)
  };
}

module.exports = {
  MAX_OBSERVATIONS: MAX_OBSERVATIONS,
  followUpReturn: followUpReturn,
  observationFromPlan: observationFromPlan,
  advanceState: advanceState,
  summaryFor: summaryFor
};
