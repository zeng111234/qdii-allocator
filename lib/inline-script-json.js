"use strict";

function serializeForInlineScript(value) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, function (character) {
    return {
      "<": "\\u003c",
      ">": "\\u003e",
      "\u2028": "\\u2028",
      "\u2029": "\\u2029"
    }[character];
  });
}

module.exports = { serializeForInlineScript };
