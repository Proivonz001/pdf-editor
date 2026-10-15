// The Content-Security-Policy exists twice: as a <meta> tag (from CSP in vite.config.ts, for
// any static host) and as a Cloudflare header (public/_headers, which adds frame-ancestors:
// that directive only works as a header). This test keeps the two from drifting apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CSP } from "../vite.config";

/** Parse Cloudflare's _headers format: a path line, then indented "Name: value" lines. */
function parseHeaders(text: string): Map<string, Map<string, string[]>> {
  const rules = new Map<string, Map<string, string[]>>();
  let current: Map<string, string[]> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      current = new Map();
      rules.set(raw.trim(), current);
      continue;
    }
    const m = /^\s+([^:]+):\s*(.*)$/.exec(raw);
    if (!m || !current) throw new Error(`Unexpected line in _headers: ${raw}`);
    const name = m[1].trim().toLowerCase();
    current.set(name, [...(current.get(name) ?? []), m[2].trim()]);
  }
  return rules;
}

const file = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const rules = parseHeaders(file);

describe("public/_headers", () => {
  it("sends the same CSP as the <meta> tag, plus frame-ancestors 'none'", () => {
    expect(rules.get("/*")?.get("content-security-policy")).toEqual([`${CSP}; frame-ancestors 'none'`]);
  });

  it("sets the CSP in one rule only (Cloudflare would join several with a comma)", () => {
    const withCsp = [...rules].filter(([, headers]) => headers.has("content-security-policy"));
    expect(withCsp.map(([path]) => path)).toEqual(["/*"]);
  });

  it("keeps the other security headers", () => {
    const all = rules.get("/*")!;
    expect(all.get("x-content-type-options")).toEqual(["nosniff"]);
    expect(all.get("referrer-policy")).toEqual(["no-referrer"]);
    expect(all.get("permissions-policy")?.[0]).toContain("camera=()");
  });

  it("caches hashed assets for a year and revalidates the entry points", () => {
    expect(rules.get("/assets/*")?.get("cache-control")?.[0]).toContain("immutable");
    for (const path of ["/", "/index.html", "/sw.js", "/manifest.webmanifest", "/registerSW.js"]) {
      expect(rules.get(path)?.get("cache-control"), path).toEqual(["no-cache"]);
    }
  });

  it("stays within Cloudflare's limits (100 rules, 2000 characters per line)", () => {
    expect(rules.size).toBeLessThanOrEqual(100);
    for (const line of file.split(/\r?\n/)) expect(line.length).toBeLessThanOrEqual(2000);
  });
});
