import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const input = args[0] ?? "input.json";
const outPath = args[1] ?? "sparql_portals.json";
const check = args.includes("--check");
const strict = args.includes("--strict");
const timeoutMs = Number(getArgValue(args, "--timeout") ?? 8000);
const concurrency = Number(getArgValue(args, "--concurrency") ?? 10);
const countryFilter = (getArgValue(args, "--country") ?? "").trim();

if (!input) {
  console.error("Usage: node filter-sparql-portals.mjs <input.json> [output.json] [--check] [--strict] [--country Germany] [--timeout 8000] [--concurrency 10]");
  process.exit(1);
}

const raw = await fs.readFile(input, "utf8");

let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"openDataPortals"')) parsed = JSON.parse(`{${trimmed}}`);
  else throw new Error("Input ist kein gültiges JSON. Root muss { ... } oder [ ... ] sein.");
}

const records =
  Array.isArray(parsed) ? parsed
  : Array.isArray(parsed?.openDataPortals) ? parsed.openDataPortals
  : Array.isArray(parsed?.portals) ? parsed.portals
  : Array.isArray(parsed?.items) ? parsed.items
  : null;

if (!Array.isArray(records)) {
  console.error("Input JSON muss ein Array sein oder ein Objekt mit Array unter 'openDataPortals' (oder 'portals'/'items').");
  process.exit(1);
}

const selected = countryFilter
  ? records.filter((p) => eqCI(p?.inCountryEn, countryFilter))
  : records;

const prepProgress = createProgress("Prepare", selected.length);
const prepared = [];
for (let i = 0; i < selected.length; i++) {
  prepared.push(preparePortal(selected[i]));
  prepProgress.tick();
}
prepProgress.done();

let result;

if (check) {
  const totalCandidates = prepared.reduce((sum, p) => sum + (p.sparqlCandidates?.length ?? 0), 0);
  const verifyProgress = createProgress("Check", totalCandidates);
  result = await verifyCandidatesByCandidate(prepared, { timeoutMs, concurrency, progress: verifyProgress, strict });
  verifyProgress.done();
} else {
  const filterProgress = createProgress("Filter", prepared.length);
  const out = [];
  for (const p of prepared) {
    if (p.sparqlCandidates.length === 0) {
      filterProgress.tick();
      continue;
    }
    const hasExplicit = p.sparqlCandidates.some((c) => c.source === "explicit");
    if (strict && !hasExplicit) {
      filterProgress.tick();
      continue;
    }
    const chosen = choosePreferred(p.sparqlCandidates);
    out.push({
      ...projectOutput(p),
      sparqlEndpoint: chosen?.url ?? null,
      sparqlGuessed: chosen ? chosen.source !== "explicit" : null,
      sparqlCandidates: p.sparqlCandidates
    });
    filterProgress.tick();
  }
  filterProgress.done();
  result = out;
}

const dir = path.dirname(outPath);
if (dir && dir !== ".") await fs.mkdir(dir, { recursive: true });
await fs.writeFile(outPath, JSON.stringify(result, null, 2), "utf8");

const stats = {
  total_in: records.length,
  total_selected: selected.length,
  country: countryFilter || null,
  exported: result.length,
  checked: check,
  strict
};
console.log(JSON.stringify(stats, null, 2));

function getArgValue(a, key) {
  const i = a.indexOf(key);
  if (i === -1) return null;
  return a[i + 1] ?? null;
}

function eqCI(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function createProgress(label, total) {
  const isTTY = process.stdout.isTTY;
  const frames = ["|", "/", "-", "\\"];
  let frame = 0;
  let done = 0;
  const width = 28;
  const start = Date.now();

  const pad2 = (n) => String(n).padStart(2, "0");
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = s % 60;
    const mm = m % 60;
    if (h > 0) return `${h}:${pad2(mm)}:${pad2(ss)}`;
    return `${mm}:${pad2(ss)}`;
  };

  const render = () => {
    const pct = total === 0 ? 1 : done / total;
    const filled = Math.round(width * pct);
    const bar = "=".repeat(filled) + " ".repeat(width - filled);
    const elapsed = Date.now() - start;
    const eta = done === 0 ? 0 : Math.max(0, Math.round((elapsed * (total - done)) / done));
    const line = `${frames[frame % frames.length]} ${label} [${bar}] ${(pct * 100).toFixed(1)}% (${done}/${total}) elapsed ${fmt(elapsed)} eta ${fmt(eta)}`;

    if (isTTY) process.stdout.write("\r" + line);
    else {
      const step = Math.max(1, Math.floor(total / 10));
      if (done === total || done % step === 0) {
        const p = total === 0 ? 100 : Math.round((done / total) * 100);
        process.stdout.write(`${label}: ${p}% (${done}/${total})\n`);
      }
    }
    frame++;
  };

  render();

  return {
    tick(inc = 1) {
      done += inc;
      if (done > total) done = total;
      render();
    },
    done() {
      if (isTTY) process.stdout.write("\n");
    }
  };
}

function isHttpUrl(s) {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeBaseUrl(s) {
  if (!isHttpUrl(s)) return null;
  return s.trim().replace(/\/+$/g, "");
}

function uniqueCandidates(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!x?.url) continue;
    const u = x.url.trim();
    if (!seen.has(u)) {
      seen.add(u);
      out.push({ url: u, source: x.source });
    }
  }
  return out;
}

function commonEndpointPaths() {
  return [
    "/sparql",
    "/sparql/",
    "/sparql-endpoint",
    "/sparqlendpoint",
    "/sparqlEndpoint",
    "/sparql/endpoint",
    "/sparql/query",
    "/endpoint/sparql",
    "/api/sparql",
    "/rdf/sparql",
    "/query",
    "/query/sparql",
    "/virtuoso/sparql",
    "/blazegraph/sparql",
    "/bigdata/sparql",
    "/fuseki/sparql"
  ];
}

function collectCandidates(p) {
  const candidates = [];

  const explicit = [
    p?.sparql?.endpoint,
    p?.sparql?.url,
    p?.sparql?.details
  ].filter(isHttpUrl).map((u) => ({ url: u.trim(), source: "explicit" }));

  candidates.push(...explicit);

  const base = normalizeBaseUrl(p?.url);
  if (base) {
    for (const suffix of commonEndpointPaths()) {
      candidates.push({ url: `${base}${suffix}`, source: "guessed" });
    }
  }

  return uniqueCandidates(candidates);
}

function preparePortal(p) {
  return { raw: p, sparqlCandidates: collectCandidates(p) };
}

function projectOutput(prepared) {
  const p = prepared.raw;
  return {
    name: p?.name ?? null,
    nameEn: p?.nameEn ?? null,
    inCountry: p?.inCountry ?? null,
    inCountryEn: p?.inCountryEn ?? null,
    inFederalState: p?.inFederalState ?? null,
    inFederalStateEn: p?.inFederalStateEn ?? null,
    inCity: p?.inCity ?? null,
    inCityEn: p?.inCityEn ?? null,
    url: p?.url ?? null,
    datasetsCount: typeof p?.datasetsCount === "number" ? p.datasetsCount : null,
    portalSoftware: p?.portalSoftware ?? null,
    levelInEu: typeof p?.levelInEu === "number" ? p.levelInEu : null
  };
}

function choosePreferred(candidates) {
  const exp = candidates.find((c) => c.source === "explicit");
  if (exp) return exp;
  return candidates[0] ?? null;
}

async function verifyCandidatesByCandidate(items, { timeoutMs, concurrency, progress, strict }) {
  const tasks = [];
  const explicitByPortal = new Map();

  for (let i = 0; i < items.length; i++) {
    const expSet = new Set(items[i].sparqlCandidates.filter((c) => c.source === "explicit").map((c) => c.url));
    explicitByPortal.set(i, expSet);
    for (const c of items[i].sparqlCandidates) tasks.push({ portalIndex: i, url: c.url, source: c.source });
  }

  const verifiedMap = new Map();
  for (let i = 0; i < items.length; i++) verifiedMap.set(i, new Map());

  let cursor = 0;

  const worker = async () => {
    while (true) {
      const myIndex = cursor++;
      if (myIndex >= tasks.length) break;

      const t = tasks[myIndex];
      const res = await validateSparqlEndpoint(t.url, timeoutMs);
      if (res.ok) {
        const m = verifiedMap.get(t.portalIndex);
        if (!m.has(t.url)) m.set(t.url, { url: t.url, source: t.source, mode: res.mode });
      }

      if (progress) progress.tick();
    }
  };

  const runners = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(runners);

  const out = [];

  for (let i = 0; i < items.length; i++) {
    const verified = Array.from(verifiedMap.get(i).values());
    if (verified.length === 0) continue;

    const expSet = explicitByPortal.get(i) ?? new Set();
    const hasExplicitAny = expSet.size > 0;
    if (strict && !hasExplicitAny) continue;

    const chosen = verified.find((v) => v.source === "explicit") ?? verified[0];

    out.push({
      ...projectOutput(items[i]),
      sparqlEndpoint: chosen.url,
      sparqlGuessed: chosen.source !== "explicit",
      sparqlVerified: true,
      sparqlVerifiedBy: chosen.mode,
      sparqlEndpointsVerified: verified.map((v) => v.url),
      sparqlEndpointsVerifiedMeta: verified
    });
  }

  return out;
}

async function validateSparqlEndpoint(endpoint, timeoutMs) {
  const ask = "ASK {}";

  const r1 = await tryAskGet(endpoint, ask, timeoutMs);
  if (r1.ok) return { ok: true, mode: "ask_get" };

  const r2 = await tryAskPost(endpoint, ask, timeoutMs);
  if (r2.ok) return { ok: true, mode: "ask_post" };

  const r3 = await tryServiceDescription(endpoint, timeoutMs);
  if (r3.ok) return { ok: true, mode: "service_description" };

  return { ok: false, mode: null };
}

function looksLikeHtml(contentType, text) {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("text/html")) return true;
  const t = (text ?? "").trim().slice(0, 500).toLowerCase();
  if (t.startsWith("<!doctype html")) return true;
  if (t.startsWith("<html")) return true;
  return false;
}

function looksLikeJsonAsk(text) {
  try {
    const v = JSON.parse(text);
    return typeof v?.boolean === "boolean";
  } catch {
    return false;
  }
}

function looksLikeXmlAsk(text) {
  const t = (text ?? "").slice(0, 200000);
  return /<sparql\b[^>]*>[\s\S]*<boolean>(true|false)<\/boolean>[\s\S]*<\/sparql>/i.test(t);
}

function isRdfContentType(ct) {
  const s = (ct ?? "").toLowerCase();
  return s.includes("text/turtle")
    || s.includes("application/rdf+xml")
    || s.includes("application/ld+json")
    || s.includes("application/n-triples")
    || s.includes("application/n-quads")
    || s.includes("text/n3")
    || s.includes("application/trig");
}

function looksLikeServiceDescription(text) {
  const t = (text ?? "").slice(0, 300000).toLowerCase();
  if (t.includes("http://www.w3.org/ns/sparql-service-description#")) return true;
  if (t.includes("sd:service")) return true;
  if (t.includes("sd:endpoint")) return true;
  if (t.includes("void:sparqlendpoint")) return true;
  return false;
}

async function fetchText(url, init, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: "follow" });
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    return { res, ct, text };
  } catch {
    return { res: null, ct: "", text: "" };
  } finally {
    clearTimeout(t);
  }
}

async function tryAskGet(endpoint, ask, timeoutMs) {
  try {
    const u = new URL(endpoint);
    u.searchParams.set("query", ask);

    const { res, ct, text } = await fetchText(
      u.toString(),
      { method: "GET", headers: { accept: "application/sparql-results+json, application/sparql-results+xml;q=0.9, application/json;q=0.8, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1" } },
      timeoutMs
    );

    if (!res || !res.ok) return { ok: false };
    if (looksLikeHtml(ct, text)) return { ok: false };

    const cts = ct.toLowerCase();
    if (cts.includes("application/sparql-results+json") && looksLikeJsonAsk(text)) return { ok: true };
    if (cts.includes("application/sparql-results+xml") && looksLikeXmlAsk(text)) return { ok: true };

    if (looksLikeJsonAsk(text)) return { ok: true };
    if (looksLikeXmlAsk(text)) return { ok: true };

    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function tryAskPost(endpoint, ask, timeoutMs) {
  const body = new URLSearchParams({ query: ask }).toString();

  const { res, ct, text } = await fetchText(
    endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/sparql-results+json, application/sparql-results+xml;q=0.9, application/json;q=0.8, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1"
      },
      body
    },
    timeoutMs
  );

  if (!res || !res.ok) return { ok: false };
  if (looksLikeHtml(ct, text)) return { ok: false };

  const cts = ct.toLowerCase();
  if (cts.includes("application/sparql-results+json") && looksLikeJsonAsk(text)) return { ok: true };
  if (cts.includes("application/sparql-results+xml") && looksLikeXmlAsk(text)) return { ok: true };

  if (looksLikeJsonAsk(text)) return { ok: true };
  if (looksLikeXmlAsk(text)) return { ok: true };

  return { ok: false };
}

async function tryServiceDescription(endpoint, timeoutMs) {
  const { res, ct, text } = await fetchText(
    endpoint,
    { method: "GET", headers: { accept: "text/turtle, application/rdf+xml;q=0.9, application/ld+json;q=0.9, application/n-triples;q=0.8, text/n3;q=0.7, */*;q=0.1" } },
    timeoutMs
  );

  if (!res || !res.ok) return { ok: false };
  if (!isRdfContentType(ct)) return { ok: false };
  if (looksLikeHtml(ct, text)) return { ok: false };
  if (!looksLikeServiceDescription(text)) return { ok: false };

  return { ok: true };
}
