"use strict";

async function streamToBuffer(value) {
  if (value == null) {
    return null;
  }

  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    return Buffer.from(value, "base64");
  }

  if (
    typeof value[Symbol.asyncIterator] === "function" ||
    typeof value.pipe === "function"
  ) {
    const chunks = [];

    for await (const chunk of value) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  throw new TypeError(
    `Formato de contenido no soportado: ${
      value?.constructor?.name || typeof value
    }`,
  );
}

module.exports = {
  streamToBuffer,
};