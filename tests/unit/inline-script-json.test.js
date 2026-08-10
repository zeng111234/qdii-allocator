const test = require("node:test");
const assert = require("node:assert/strict");

test("inline JSON cannot terminate the surrounding script element", function () {
  const { serializeForInlineScript } = require("../../lib/inline-script-json");
  const value = {
    title: "</script><img src=x onerror=alert(1)>",
    separators: "line\u2028paragraph\u2029end"
  };
  const serialized = serializeForInlineScript(value);

  assert.doesNotMatch(serialized, /<\/script/i);
  assert.doesNotMatch(serialized, /[<>\u2028\u2029]/);
  assert.deepEqual(JSON.parse(serialized), value);
});
