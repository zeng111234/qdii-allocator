"use strict";

// EastMoney's accumulated NAV is a cumulative accounting value, not a price
// that can be bought at the start of an arbitrary test window.  Build a
// reinvested total-return index from each period's accumulated-NAV change
// divided by the previous unit NAV, so dividends before the window do not
// dilute the measured return.
const TOTAL_RETURN_BASIS = "reinvested-total-return-index-v1";
const TOTAL_RETURN_FORMULA = "index_t=index_(t-1)*(1+(accNav_t-accNav_(t-1))/nav_(t-1))";

function validSourceRow(row) {
  return !!row && typeof row.date === "string" && row.date.length > 0 &&
    Number.isFinite(Number(row.nav)) && Number(row.nav) > 0 &&
    Number.isFinite(Number(row.accNav)) && Number(row.accNav) > 0;
}

function buildReinvestedTotalReturnIndex(rows) {
  const ordered = (rows || []).filter(validSourceRow).slice().sort(function (left, right) {
    return left.date.localeCompare(right.date);
  });
  if (ordered.length === 0) return [];

  let indexValue = 1;
  const result = [Object.assign({}, ordered[0], {
    unitNav: Number(ordered[0].nav),
    nav: indexValue,
    totalReturnIndex: indexValue,
    totalReturnBasis: TOTAL_RETURN_BASIS
  })];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const periodReturn = (Number(current.accNav) - Number(previous.accNav)) / Number(previous.nav);
    const factor = 1 + periodReturn;
    if (!Number.isFinite(factor) || factor <= 0) continue;
    indexValue *= factor;
    result.push(Object.assign({}, current, {
      unitNav: Number(current.nav),
      nav: indexValue,
      totalReturnIndex: indexValue,
      totalReturnBasis: TOTAL_RETURN_BASIS
    }));
  }
  return result;
}

module.exports = {
  TOTAL_RETURN_BASIS: TOTAL_RETURN_BASIS,
  TOTAL_RETURN_FORMULA: TOTAL_RETURN_FORMULA,
  buildReinvestedTotalReturnIndex: buildReinvestedTotalReturnIndex
};
