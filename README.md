# Rask API v3 SDK acceptance harness

A mock of the whole v3 API that checks every request against the contract, plus a control API and one list of
scenarios, so the Go, Python, TypeScript, PHP and Java SDKs are all tested for the same things (the scenarios S1–S17, and
custom `base_url`). You drive it over HTTP from any language.

## Start

Node 22 or newer, nothing to install:

```sh
node bin/rask-sdk-acceptance.mjs
```

The same from anywhere, or in Docker:

```sh
npx --yes /path/to/rask-sdk-acceptance
docker build -t rask-sdk-acceptance . && docker run --rm -p 4010:4010 -p 4011:4011 rask-sdk-acceptance
```

It prints what you need:

```
base_url        http://127.0.0.1:4010/custom/prefix/v3
control         http://127.0.0.1:4010/__control
other host      http://localhost:4011
test API key    raskai_test_key_AcceptanceHarnessTestKeyNotARealCredentialDoNotUs
```

| Flag | Default | |
|---|---|---|
| `--port` | 4010 | API and control. `0` picks a free port, for one harness per test worker |
| `--other-port` | port + 1 | The "another host" listener |
| `--prefix` | `/custom/prefix/v3` | API path prefix. The default is deliberately not `/v3`, so a hardcoded path fails |
| `--host` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `--public-host`, `--other-public-host` | bind address, `localhost` | Host names in the URLs it hands out. In Compose, give each listener a network alias |
| `--spec`, `--scenarios` | the copies in this repo | Other contract or scenario file |

Publish Docker ports 1:1: the harness writes its own ports into presigned URLs and redirects. For other ports pass
`--port` and `--other-port` too. In Compose, wait on `GET /__control/health`.

The other host has both another name and another port than the API, so an HTTP client treats it as cross-host. One
harness runs one scenario at a time. To run tests in parallel, start one per worker with `--port 0`.

## Run the scenarios from your language

`scenarios/scenarios.json` is the list. The loop every language writes, in about 100 lines:

```
for each s in GET /__control/scenarios?lang=go where s.applies and not s.slow:
    scenario = POST /__control/scenarios/{id}/start  {"lang": "go"}     # resets, runs scenario.setup, fills in URLs
    set the environment to exactly scenario.client.env                  # unset RASK_API_KEY, RASK_BASE_URL, RASK_LOG otherwise
    client = your SDK, constructed from scenario.client.args            # api_key, base_url, timeout_seconds
    for call in scenario.calls: run it, keep the result or the error
    check scenario.expect_sdk against what you kept
    result = POST /__control/scenarios/{id}/verify  {"lang": "go", "sdk_passed": true, "sdk_detail": ""}
    assert result.pass, result.failures                                 # the harness checks scenario.wire itself

assert GET /__control/report?lang=go has complete == true               # nothing skipped, nothing failed
```

`test/reference/runner.mjs` is this loop in JavaScript and `test/reference/sdk.mjs` a tiny SDK that passes it. Port them
if that is quicker. By hand, with curl:

```sh
C=http://127.0.0.1:4010/__control
curl -s -X POST $C/scenarios/S3.retry-post-same-key/start -d '{"lang":"go"}' -H 'Content-Type: application/json'
# ... run the SDK: createFolder fails once with 503, then succeeds ...
curl -s -X POST $C/scenarios/S3.retry-post-same-key/verify -d '{"lang":"go"}' -H 'Content-Type: application/json'
# {"scenario":"S3.retry-post-same-key","lang":"go","pass":true,"failures":[],"requests":2}
```

## The scenario list

94 scenarios. S8 is listed as Later and S17 applies to TypeScript only. `S3.total-budget` (2 minutes) and
`S13.default-timeout-covers-long-poll` (45 s) are `slow`: the report lists them apart until you ask for `?slow=true`.

| Ids | Covers |
|---|---|
| `S1.*`, `S2.*` | Key by argument or `RASK_API_KEY`, error naming the variable, redaction, default base URL |
| `BU1`–`BU7` | **Base URL:** path prefix, trailing slash, `RASK_BASE_URL`, argument beats env, no key on a cross-host redirect, presigned PUT without `Authorization`, `/v3/...` links under a custom prefix |
| `S3.*` | Retries, backoff, `Retry-After`, what is not retried, `idempotency_key_in_use`, the 120 s budget |
| `S4.*` | UUIDv4 keys, per logical call, stable across retries, override, exposed, `deleteSegment` |
| `S5.*` | Auto-paging over 3 pages, page-level access, short and empty pages, filters kept |
| `S6.*` | `jobs.wait`: `wait_seconds=20`, `Retry-After`, failed, canceled, timeout, 304 |
| `S7.*` | `upload_file`: signed headers, stream, whole-file retries, expired URLs |
| `S9.*`, `S10.*`, `S11.*` | Typed problems for each status, unknown codes, HTML errors, ETags and `If-Match`, raw status and headers |
| `S12.*` | Unknown enums, union variants and fields, in a job and swept over every operation; clearing with `""`; omitted stays omitted |
| `S13.*`–`S17.*` | Timeouts, deprecation warnings, `User-Agent`, debug logs, browser refusal |

A scenario:

```json
{
  "id": "S3.retry-post-same-key",
  "design": ["S3", "S4"],
  "title": "A POST is retried because it carries a key; the key and the body do not change",
  "setup": [{ "method": "POST", "path": "/__control/script",
              "body": { "operationId": "createFolder", "steps": [{ "status": 503, "problem": "temporarily_unavailable", "retry_after": 1 }] } }],
  "calls": [{ "op": "createFolder", "body": { "name": "S3" } }],
  "wire": [{ "assert": "count", "where": { "operationId": "createFolder" }, "equals": 2 },
           { "assert": "same", "where": { "operationId": "createFolder" }, "field": "header:Idempotency-Key" }],
  "expect_sdk": [{ "kind": "returned", "call": 0 }]
}
```

Fields: `id`, `design`, `title`, `note`, `languages`, `status` (`later` skips it), `slow`, `client`, `setup`, `calls`,
`wire`, `expect_sdk`. `{{base_url}}` and friends are filled in by `start` and `GET /__control/scenarios/{id}`.

### `calls`

A call is an operation, `{"op": "<operationId>", "path": {}, "query": {}, "body": {}, "if_match": "...", "idempotency_key": "..."}`,
or a helper:

| `helper` | Fields | Your SDK's |
|---|---|---|
| `jobs.wait` | `job_id` or `job_id_from_call` (index of an earlier call), `timeout_seconds` | `jobs.wait` |
| `uploads.upload_file` | `source` (`path` or `stream`), `filename`, `content_type`, `content` (`size_bytes`, `fill: index_mod_256`: byte *i* is *i* mod 256), `on_progress` | `uploads.upload_file` |
| `iterate` | `op`, `path`, `query` | auto-paging iterator; keep the items |
| `first_page`, `next_page` | `op`, `path`, `query`; `after_call` | page-level access |
| `sweep_operations` | | call every operation with `has_json_response` from `GET /__control/operations`, using its `sample` |

### `expect_sdk`: what only your test can see

`call` is the index in `calls`, and defaults to the last.

| `kind` | Means |
|---|---|
| `returned`, `returned_or_raised` | The call returned; either outcome is fine |
| `raised` | The call raised, with `error_class`, `status`, `code`, `fields` (exact values), `present` (names that must exist) and `request_id_matches_wire`. `error_class` names the DESIGN's class; where it says nothing, your per-status subclass of `RaskError` is fine |
| `raised_before_network` | Construction or the call failed, mentioning `message_contains`, with no request sent (a compile error counts) |
| `config` | The client's setting `field` equals `equals`: `base_url`, `timeout_seconds`, `jobs.wait.timeout_seconds` |
| `repr_redacts` | `secret` does not appear in `repr`, `toString`, or a dump of the client |
| `field` | On the result: the JSON Pointer `path` equals `equals` or is `present`; `raw_status` is the HTTP status |
| `header_exposed` | The raw response header `name`, with no second call: `equals`, `matches`, `equals_field` (a body pointer), `matches_wire` |
| `idempotency_key_exposed` | The key on a result or an error: `equals`, or `matches_wire` (it was the one sent) |
| `items`, `pages` | From `iterate`: `count`, `ids`. From a page: `item_count`, `has_more` |
| `warnings` | `count` deprecation warnings, `per_operation` |
| `progress` | `on_progress` reached `final_bytes` |
| `logs` | `must_contain`, `must_not_contain`, `must_not_contain_wire` (a recorded request's query value), or `empty` |
| `injected_values_preserved` | Each entry in the recorded `response.injections` can be read from the result at its pointer. How you expose an unknown value is yours to design |
| `manual` | Read `text` and check it the way your language can (S14 markers, S17) |

### `wire`: what the harness checks for you

`where` filters by `listener`, `operationId`, `method`, `path`, `status`. `nth` picks one match (`-1` is the last), and
no `nth` means all of them. `__storage_put` is the operationId of a presigned PUT.

| `assert` | Fields |
|---|---|
| `count` | `equals`, `at_least`, `at_most` |
| `header`, `query` | `name`, then `equals`, `matches`, `one_of`, `present` or `absent` |
| `path`, `status` | `equals`, `matches`, `one_of` |
| `body` | `pointer`, then `equals`, `absent`, ... |
| `field` | `field`: `header:<name>`, `query:<name>`, `body:<pointer>`, `body_sha256`, `path`, `url` |
| `same`, `distinct` | `field`, across the matches |
| `gap_at_least_ms` | `between: [i, j]`, `ms` |
| `total_gap_at_least_ms`, `total_gap_at_most_ms` | `ms` |
| `order` | `sequence` of operationIds, in order, others allowed between |

Every `verify` also fails on any recorded contract violation and on any `Authorization` that reached the other host,
whatever the scenario asserts.

## What the mock does

**Validates every request.** Path, query, headers and body against the contract, in its closed request form. On a
violation it answers 400 with a `Problem`, `code: contract_violation`, one `errors[]` entry per problem, and a message
that names the likely cause:

```json
{"status":400,"code":"contract_violation","retry":"none",
 "detail":"createDub: createDub requires Idempotency-Key (a real server answers 400 idempotency_key_required).",
 "errors":[{"pointer":"header:Idempotency-Key","code":"missing_required_header","detail":"..."}]}
```

That covers paths outside the prefix, `//`, a trailing `/`, `/v3` appended twice, unknown or repeated query parameters
(arrays are one comma-separated value), wrong types, `null` in a body, unknown fields, a body where none is taken,
`Idempotency-Key` or `If-Match` missing where required or sent where the contract takes none, `If-Match: *`, and an
`If-Match` without its quotes.

A real server answers some of these differently (`If-Match` missing is 428, for one), which is why the message says so.
To test how your SDK handles those answers, script them. Three answers keep the contract's own form and are still
recorded as violations: no `Authorization` or another scheme is 401, a key in the query string is 400 `token_in_query`,
a bad cursor on a paged list is 400 `invalid_cursor`.

**Answers from the contract.** The first example of the success response (or a schema-built body, where there is none),
with path ids echoed, `Location`, `ETag`, `X-Request-Id`, `RateLimit` and `Retry-After` set as declared. Every body is
checked against the response schema; a mismatch fails `verify` as a harness bug. An unprogrammed `getJob` is `succeeded`.

`Location` and `links.*` stay path-absolute with `/v3`, exactly as the contract says, whatever the prefix. An SDK that
follows them must use the id or re-root them under `base_url` (scenario `BU7`).

## Control API

Everything is JSON under `/__control`, on the API port, outside the prefix. `GET /__control/health` lists it.

| Endpoint | |
|---|---|
| `GET /health` | URLs, prefix, test key, endpoints |
| `GET /operations[?operationId=]` | Each operation's method, path, key and `If-Match` rules, and a valid `sample` request |
| `GET /requests[?operationId=&listener=&since_seq=]`, `DELETE /requests` | The recording |
| `POST /reset` | Clears requests, scripts, jobs, pages, uploads; keeps the report |
| `POST /script`, `GET /script` | Queue responses: `{"operationId": "getMe", "steps": [...], "append": false}` |
| `POST /jobs`, `GET /jobs/{id}` | Job programs |
| `POST /pages` | Paged lists |
| `GET /uploads/{id}` | An upload's state |
| `GET /scenarios[?lang=]`, `GET /scenarios/{id}` | The list |
| `POST /scenarios/{id}/start`, `POST /scenarios/{id}/verify` | `{"lang": "go"}`; verify also takes `sdk_passed`, `sdk_detail` |
| `GET /report[?lang=&slow=true]`, `DELETE /report` | `passed`, `failed`, `not_run`, `slow_not_run`, `complete` |

A recorded request has `seq`, `listener` (`api` or `other`), `received_at_ms`, `method`, `url`, `path`, `raw_query`,
`raw_query_params`, `operationId`, `path_params`, `headers` (lowercase names), `body`, `body_text`, `body_bytes`,
`body_sha256`, `violations`, and `response` (`status`, `headers`, `body`, `raw`, `scripted`, `injections`, `delay_ms`,
`dropped`, `self_check`).

### Script steps

Steps answer the next requests to that operation, in order, then normal answers resume. A request that violates the
contract does not use up a step. `operationId` may be `"*"` (every operation without its own queue) or `"__storage_put"`.
`{}` is a normal answer. A typo or a body that does not validate fails the `POST /script` itself.

| Field | Effect |
|---|---|
| `status` | HTTP status. 502 and 504 default to an HTML body, as a gateway sends |
| `problem` | A problem code: the contract's example, with `status` taken from it. A code it does not know needs `status` |
| `body`, `raw` + `content_type` | Replace the body. `off_contract: true` allows one that does not validate |
| `patch` | Deep-merge into the body: `{"problem": "precondition_failed", "patch": {"current_etag": "\"s-1\""}}` |
| `example` | Another named example of the success response |
| `headers` | Extra or replaced headers, e.g. `{"Idempotent-Replayed": "true"}` |
| `retry_after` | `Retry-After` in seconds. Defaults to 1 on 429, 503 and `idempotency_key_in_use`; `null` leaves it out |
| `delay_ms` | Wait before answering |
| `drop` | Close the connection: `true` or `before_headers`, `after_headers`, `mid_body` |
| `inject` | S12: `true` or `{"enum": true, "union": true, "field": true}`. Puts unknown values at every open enum, open union and open object, also where the example has a null or an empty list; the record lists each in `response.injections` |
| `deprecation` | `Deprecation`, `Sunset` and `Link` headers. `true`, or `{deprecation, sunset, link}` |
| `redirect` | `"other"`, or `{"to": "other" or an absolute URL, "status": 307}`. The other host answers as the operation would |
| `job` | On a job start: answer with this job program's id and state, with its `Location` |
| `upload` | On `createUpload` or `getUpload`: `{"expired": true}` signs a URL already past `expires_at` |
| `expired` | On `__storage_put`: storage says this URL has expired, and it stays dead |
| `repeat` | A number, or `"forever"` |

### Jobs

```json
POST /__control/jobs {"id": "job-1", "type": "dub", "states": ["queued", "running", "succeeded"], "retry_after": 1}
```

Each `getJob` moves one state on, and the last repeats. `failed` carries the contract's error for that type (override
with `error`), `succeeded` its result (`result`). Non-terminal answers carry `Retry-After` and an ETag; a matching
`If-None-Match` answers 304. A scripted step on `getJob` goes first, and a dropped response does not use up a state.
`hold_ms` delays each poll. A status outside the contract is allowed for S12, but the order must stay monotonic.

### Pages

```json
POST /__control/pages {"operationId": "listProjects", "pages": 3, "page_size": 2}
POST /__control/pages {"operationId": "listSegments", "sizes": [2, 0, 1]}
```

Items get ids `<operationId>-item-<n>`. Cursors embed a hash of the filters (not `limit`), so changed filters or a forged
cursor answer 400 `invalid_cursor`.

### Uploads and the other host

`createUpload` signs a URL on the other host for the request's own `content_type` and `size_bytes`. The PUT is judged as
S3 would judge it, and each refusal is recorded as a violation: `Authorization` present is 400 `InvalidArgument`, another
`Content-Type` or length or a changed query string is 403 `SignatureDoesNotMatch`, a chunked PUT is 411. An expired URL
is 403 `AccessDenied` with `Request has expired`. `getUpload` re-signs. `completeUpload` before a good PUT is 409
`upload_incomplete`. The record of a PUT holds `body_bytes` and `body_sha256`, never the bytes.

The other host records every other request and answers 200, except `GET /__other/health`.

## Safety

The harness binds to loopback and holds no real credentials; use only the printed test key, since recorded requests keep
`Authorization` as sent. Never send traffic in `S2.default-base-url`: the default base URL is production. An SDK that
ignores `RASK_BASE_URL` will reach production with the test key during `BU3`; block egress in CI if you can.

## Judgement calls to check

- `S9.status-429-past-budget` and `S9.status-503-past-budget` assume that a `Retry-After` longer than the 120 s budget
  ends the retries at once, so the error can be tested without a two-minute wait. The requirement S3 does not say this outright.
- `S3.retry-connection-errors` treats a connection lost in mid-body as a connection error, so it is retried.
- The list covers five languages. PHP is the latest addition, and S15 expects `rask-sdk-php/...`.

## Working on the harness

```sh
npm ci                     # dev only: Ajv, the second opinion on the hand-written validator
npm test                   # about 15 s; without npm ci the Ajv comparison is skipped
RUN_SLOW=1 npm test        # adds the two slow scenarios
```

The tests run every operation and declared problem over HTTP against the contract, the validator against Ajv on every
example and on mutated copies, and the reference SDK through all scenarios. Each scenario also has a fault that must make
it fail, since a scenario that passes whatever the SDK does tests nothing.

`contract/openapi.json` is a copy; `contract/SOURCE.json` says of what. To update it, copy the file, set `commit` and
`sha256`, and run `npm test`. A new schema keyword stops the harness at startup until `src/schema.mjs` implements it.

## License

MIT. See [LICENSE](LICENSE).
