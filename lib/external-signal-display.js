"use strict";

function normalizeExternalSignalsForPage(raw, now) {
  const envelope = raw && typeof raw === "object" ? raw : {};
  const source = envelope.data && typeof envelope.data === "object" ? envelope.data : envelope;
  const timestamp = source.fetchedAt || source.cachedAt || envelope.fetchedAt || envelope.cachedAt || null;
  const currentTime = now ? new Date(now) : new Date();
  const signalTime = timestamp ? new Date(timestamp) : null;
  const currentDate = Number.isFinite(currentTime.getTime()) ? currentTime.toISOString().slice(0, 10) : null;
  const signalDate = signalTime && Number.isFinite(signalTime.getTime()) ? signalTime.toISOString().slice(0, 10) : null;
  const sourceStatus = source.status || envelope.status || "unknown";

  return {
    items: Array.isArray(source.items) ? source.items.slice(0, 10) : [],
    tickerOpinions: Array.isArray(source.tickerOpinions) ? source.tickerOpinions : [],
    themeScores: source.themeScores && typeof source.themeScores === "object" ? source.themeScores : {},
    cachedAt: timestamp,
    status: signalDate && currentDate && signalDate !== currentDate ? "stale" : sourceStatus
  };
}

module.exports = { normalizeExternalSignalsForPage };
