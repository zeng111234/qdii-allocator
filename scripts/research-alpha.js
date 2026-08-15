"use strict";

const navCache = require("../data/nav-cache.json");
const fundsConfig = require("../data/funds.json");
const {
  buildAlphaResearchReport,
  writeAlphaResearchReport
} = require("../lib/alpha-research-report");

const report = buildAlphaResearchReport({
  navCache: navCache,
  fundsConfig: fundsConfig
});

if (process.argv.includes("--write")) writeAlphaResearchReport(report);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
