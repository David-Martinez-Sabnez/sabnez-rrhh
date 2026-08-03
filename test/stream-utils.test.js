"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { streamToBuffer } = require("../srv/lib/stream-utils");

test("normaliza adjuntos devueltos como Buffer, base64 o stream", async () => {
  const expected = Buffer.from("archivo compatible con Cloud Foundry");

  assert.deepEqual(await streamToBuffer(expected), expected);
  assert.deepEqual(await streamToBuffer(expected.toString("base64")), expected);
  assert.deepEqual(
    await streamToBuffer(Readable.from([expected.subarray(0, 10), expected.subarray(10)])),
    expected,
  );
});
