"use strict";

function normalizarSideEffectFotoInline(requestUrl, method = "GET") {
  if (method !== "GET" || typeof requestUrl !== "string") return requestUrl;

  const [pathname, queryString = ""] = requestUrl.split("?", 2);
  if (!/\/admin\/Empleados\([^/]+\)$/i.test(pathname) || !queryString) {
    return requestUrl;
  }

  const params = new URLSearchParams(queryString);
  const selected = params.get("$select")?.split(",") || [];
  const fotoIndex = selected.indexOf("foto_content");
  if (fotoIndex <= 0 || fotoIndex !== selected.length - 1) return requestUrl;

  selected.splice(fotoIndex, 1);
  selected.unshift("foto_content");
  params.set("$select", selected.join(","));
  return `${pathname}?${params.toString()}`;
}

module.exports = { normalizarSideEffectFotoInline };
