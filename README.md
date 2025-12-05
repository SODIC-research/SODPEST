# SODPEST (SPARQL Open Data Portal Endpoint SPARQL Tester): 

A small, dependency-light CLI tool that **derives SPARQL endpoint candidates** for Open Data portals and optionally **verifies** them via real SPARQL protocol checks.

It is designed for research-grade exports, for example when you want a reproducible list of portals with **validated SPARQL endpoints** (instead of “/sparql” guesses that lead to HTML pages, redirects, or 404s).

## What it does

For each portal record, SODPEST can:

1. **Collect explicit endpoints** (if present in the input under `sparql.endpoint`, `sparql.url`, or `sparql.details`)
2. **Guess common endpoint paths** by appending **16 well-known SPARQL endpoint suffixes** to the portal base URL
3. Optionally **verify candidates over the network**
   - `ASK {}` via HTTP GET (`?query=...`)
   - `ASK {}` via HTTP POST (`application/x-www-form-urlencoded`)
   - SPARQL Service Description (RDF plus `sd:` markers)

Candidates are always tagged with their origin:
- `source: "explicit"` for curated input fields
- `source: "guessed"` for derived URL patterns

## Why `ASK {}`

`ASK {}` is a minimal query that does not depend on specific data content and is typically accepted by SPARQL endpoints. This keeps the validation fast and robust across heterogeneous portals.

## Requirements

- Node.js 18+ (global `fetch` is available)
- No npm dependencies required

## Files

- `filter-sparql-portals.mjs` (CLI script)
- `input.json` (default input file name)
- `sparql_portals.json` (default output file name)

## Input format

Accepted input roots:

- An array of portal objects
- Or an object containing an array under one of:
  - `openDataPortals`
  - `portals`
  - `items`

Minimal example:

```json
{
  "openDataPortals": [
    {
      "url": "https://opendata.example.org",
      "inCountryEn": "Germany"
    }
  ]
}
```

Optional explicit SPARQL fields (any of these will be treated as `source: "explicit"` if they are valid HTTP(S) URLs):

```json
{
  "sparql": {
    "endpoint": "https://opendata.example.org/sparql",
    "url": "https://opendata.example.org/sparql",
    "details": "https://opendata.example.org/sparql"
  }
}
```

## Installation

Clone the repo and run directly with Node.js:

```bash
node filter-sparql-portals.mjs
```

## CLI usage

General form:

```bash
node filter-sparql-portals.mjs <input.json> [output.json] [--check] [--strict] [--country Germany] [--timeout 8000] [--concurrency 10]
```

### 1) Default run

Reads `input.json`, writes `sparql_portals.json`:

```bash
node filter-sparql-portals.mjs
```

### 2) Derive candidates only (no network checks)

Exports portals that have at least one candidate and selects a preferred endpoint (explicit preferred, otherwise first guess).

```bash
node filter-sparql-portals.mjs input.json sparql_portals_candidates.json
```

Output includes:
- `sparqlEndpoint`
- `sparqlGuessed`
- `sparqlCandidates` (with `source` tags)

### 3) Verify candidates over the network (`--check`)

Validates each candidate using `ASK {}` (GET, then POST) and falls back to Service Description checks.

```bash
node filter-sparql-portals.mjs input.json sparql_portals_checked.json --check
```

Additional output fields include:
- `sparqlVerified: true`
- `sparqlVerifiedBy: "ask_get" | "ask_post" | "service_description"`
- `sparqlEndpointsVerified`
- `sparqlEndpointsVerifiedMeta`

### 4) Strict mode (`--strict`)

Strict mode requires that a portal has at least one explicit SPARQL URL in the input.

- Without `--check`: portals are only exported if they contain at least one explicit candidate.
- With `--check`: portals are only exported if they contain at least one explicit candidate (verification still runs across all candidates, and an explicit verified endpoint is preferred if available).

```bash
node filter-sparql-portals.mjs input.json sparql_portals_strict.json --check --strict
```

### 5) Country-filtered export (paper-ready subset)

```bash
node filter-sparql-portals.mjs input.json sparql_portals.json --check --country Germany
```

## Flags

- `--check`  
  Enables network validation of endpoint candidates.

- `--strict`  
  Only export portals that have at least one explicit SPARQL URL in the input (curated metadata).

- `--timeout <ms>`  
  Per-request timeout in milliseconds (default: `8000`).

- `--concurrency <n>`  
  Number of parallel validation workers (default: `10`).

- `--country <CountryNameEn>`  
  Filters portals by exact case-insensitive match on `inCountryEn` (example: `Germany`).

## Candidate guessing

If the portal has a base URL (e.g., `https://example.org`), SODPEST appends these suffixes as `source: "guessed"`:

- `/sparql`
- `/sparql/`
- `/sparql-endpoint`
- `/sparqlendpoint`
- `/sparqlEndpoint`
- `/sparql/endpoint`
- `/sparql/query`
- `/endpoint/sparql`
- `/api/sparql`
- `/rdf/sparql`
- `/query`
- `/query/sparql`
- `/virtuoso/sparql`
- `/blazegraph/sparql`
- `/bigdata/sparql`
- `/fuseki/sparql`

## Validation details

A candidate is considered valid if any of the following succeeds:

1. ASK via GET  
   - Sends `?query=ASK {}`  
   - Rejects HTML responses  
   - Accepts JSON/XML SPARQL results (also tolerates generic JSON/XML if it contains a boolean ASK result)

2. ASK via POST  
   - Sends `query=ASK {}` as `application/x-www-form-urlencoded`  
   - Same response checks as GET

3. Service Description  
   - Requests RDF (Turtle, RDF/XML, JSON-LD, N-Triples, N-Quads, TriG, N3)  
   - Requires RDF content type and markers like:
     - `http://www.w3.org/ns/sparql-service-description#`
     - `sd:Service`, `sd:endpoint`
     - `void:sparqlEndpoint`

## Output overview

Two modes:

### Without `--check`
Exports portals with candidates and chooses a preferred endpoint:
- Prefer `source: "explicit"`
- Otherwise first guessed candidate

### With `--check`
Exports portals with at least one verified candidate:
- Prefer verified `source: "explicit"`
- Otherwise first verified candidate

## Reproducibility notes

Network validation is inherently time-dependent:
- endpoints can rate-limit, go down temporarily, or change behavior
- results can differ between runs and dates

For research exports, store alongside your output:
- run date and timezone
- `--timeout` and `--concurrency`
- input dataset version or hash

## Limitations

- Some SPARQL services require authentication or custom headers and will be reported as not verified.
- Some endpoints only support specific SPARQL result formats; the validator focuses on common JSON/XML ASK patterns and RDF Service Description.
- Verified endpoints list order may vary across runs due to concurrency and response timing.

## Standards (useful references)

- SPARQL 1.1 Protocol: https://www.w3.org/TR/sparql11-protocol/
- SPARQL 1.1 Service Description: https://www.w3.org/TR/sparql11-service-description/
- SPARQL Service Description namespace: http://www.w3.org/ns/sparql-service-description#

## 📖 Citation

```
@misc{SODPEST2026,
  title        = {SODPEST - SPARQL Open Data Portal Endpoint SPARQL Tester},
  author       = {Florian Hahn in the SODIC Research Group},
  year         = {2026},
  howpublished = {\url{https://github.com/SOIDC-research/SODPEST}},
  note         = {Accessed: January 01, 2026}
}
```

---

## ⚖️ License

Released under the MIT License. See `LICENSE` for details. 


## 👩‍🔬 Maintainer

**Florian Hahn**  
SODIC Research Group, TU Chemnitz  
[Website](https:/tu-chemnitz.de/informatik/dm/team/fh.php) — Contact: `florian.hahn@informatik.tu-chemnitz.de`
