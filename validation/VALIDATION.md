# Validation — free-model-aggregator-02 entry

Entry: `main.ts` + `lib/providers.ts` + `lib/wire.ts`, commit `d1608fe`
(doc-edit pass) on top of the entry commit `f4e6515`, beacon `ad7f825`.
Repo: https://github.com/cgxaltarm/free-model-aggregator-02

## 1. `--list` (catalog)

`node main.ts --list` (with trial-0 `prompt.txt`) prints one provider,
`base_url https://openrouter.ai/api/v1`, `key_env OPENROUTER_API_KEY`,
`wire openai`, exactly the 14 free ids in brief order, once each.
Re-run after the doc-edit: byte-identical (`cmp` clean).

## 2. grade-local, no OpenRouter key (dummy key, `--instances 3`)

Command:
`OPENAI_API_KEY=dummy-grade-local-key ANTHROPIC_API_KEY=dummy-grade-local-key
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <entry>
--driver process --instances 3 --save entry/validation/grade-local`

Result (raw: `validation/grade-local/`, `summary.json`, `trial-0/`):
- The harness voided trial 0 as an infrastructure fault
  ("60 of 60 forwarded requests met an upstream error") and stopped, so
  trials 1–2 have no grade-local data. This is the expected no-key outcome:
  every gateway call answered 401 `authentication_error`.
- Trial-0 scorer run on the kept export + cassette:
  **score 5 (quality 0, served 0, wire 0, failover 0, catalog 100)**,
  `upstream_calls 0`, `working 0` (`validation/grade-local/scores-trial-0/scores.json`).
- What the no-key run DID prove: register succeeded, env drove all 6 prompts,
  entry exited 0 in 1.581 s (no crash/timeout), all 6 prompts delivered as
  HTTP 502 with the failures trail recorded (8 rows each: own 502 + 7 trail
  rows, code `authentication_error`, model named), catalog route lists exactly
  the 14 ids on BOTH auth headers (catalog 100). The entry spent exactly its
  60-call trial budget (p01–p05 consumed 58 calls, p06 got the last 2).
- `--trials 3` is rejected for agent/v1 kits; the correct flag is
  `--instances 3` (used here). A live grade-local trial refuses to start
  without OPENAI_API_KEY or ANTHROPIC_API_KEY set at all.

## 3. Mock-gateway trials (no real key; stub in /tmp, never in the repo)

Stub: `/tmp/mock-gateway.mjs` — first POST of the run answers 429
`rate_limit_exceeded`, every later POST answers 200 with a completion that
echoes the prompt's token (JSON `{"token": "<TOKEN>"}` for JSON-mode,
plain token otherwise; SSE with two content deltas + usage chunk + [DONE]
for streams). Cassette built from the stub's call log by
`/tmp/build-cassette.mjs` (entries + `bodies/<sha256>`).
Runner: `validation/run-mock-trial.sh <trial 0|1|2> <label>` (re-runnable).

| Run | Score | quality | served | wire | failover | catalog | upstream_calls | valid | checks |
|---|---|---|---|---|---|---|---|---|---|
| trial-0 A | 99 | 98 | 100 | 100 | 100 | 100 | 6 | 6/6 | 39/39 |
| trial-0 B | 99 | 98 | 100 | 100 | 100 | 100 | 6 | 6/6 | 39/39 |
| trial-1 A | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 6/6 | 39/39 |
| trial-2 A | 94 | 90 | 100 | 100 | 100 | 100 | 6 | 6/6 | 39/39 |

- Every mock run: 7 gateway calls (1× 429 + 6× 200), entry exit 0,
  `real_model pass`.
- Determinism: `trial-0 A` vs `trial-0 B` `state.json` byte-identical (`cmp` clean).
- Why quality is 98/90 instead of 100 in the mock: the stub's single 429 hits
  the first call of the trial, and per the briefed policy a model that refused
  is demoted for the rest of the trial. Trial-0: super-vl 429s on p01, so p01
  and p04 fall to gemma-4-31b (1210 vs best 1303) → quality 98.
  Trials 1–2: the draw puts a plain prompt first, so inkling-2-small 429s on
  p01 and all four non-JSON prompts fall to super-vl (1303 vs best 1475) →
  quality 90. This is the measured cost of whole-trial demotion after ONE
  transient 429; with no refusal the routing serves every prompt at its best
  (quality 100 by construction — first candidate per prompt is the best model).
  The policy follows the build brief exactly; a retry-the-refused-model
  variant is a possible follow-up, not built here.
- Note: the per-trial manifest differs across practice trials (prompt order,
  wire and requirements are drawn per trial — e.g. trial-1 p01 is anthropic
  plain, p02 is tools, p05 is openai stream). The entry routes from the
  brief's manifest row by arrival order, never from hardcoded prompt roles,
  so it handles every draw.

## 4. Still needs a real key

- Live quality (does inkling-2-small actually echo the token? does super-vl
  echo it in JSON-mode?), live failover behaviour on real 429/5xx, and any
  real grade-local score: all require an OpenRouter key pushed as an entry
  secret. Nothing in this validation substitutes for that.
- The mock proves wire, catalog, token verification, failover plumbing,
  streaming translation (both wires, incl. anthropic-stream in trial-2 p01)
  and determinism — not live model behaviour.
