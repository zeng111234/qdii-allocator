var fd = require("./lib/fund-data");
var fs = require("fs");
var data = JSON.parse(fs.readFileSync("data/funds.json", "utf-8"));
var cache = JSON.parse(fs.readFileSync("data/nav-cache.json", "utf-8"));

var missing = data.funds.filter(function(f) { return !cache[f.code]; }).map(function(f) { return f.code; });
console.log("Missing: " + missing.length + " funds");

async function run() {
  for (var i = 0; i < missing.length; i++) {
    console.log("[" + (i + 1) + "/" + missing.length + "] " + missing[i]);
    try {
      var d = await fd.getFundNavHistory(missing[i], 750);
      console.log("  -> " + d.length + " records");
    } catch(e) {
      console.log("  -> ERR: " + e.message);
    }
    await new Promise(function(r) { setTimeout(r, 800); });
  }
  var c2 = JSON.parse(fs.readFileSync("data/nav-cache.json", "utf-8"));
  console.log("Final cache: " + Object.keys(c2).length + " funds");
}

run().then(function() { console.log("ALL DONE"); }).catch(function(e) { console.error(e); });