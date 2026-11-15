// free-model-aggregator-02 entry: one server, two client wires, a real free model behind
// every answer, chosen by rating.
//
// DESIGN — RATING-GREEDY ROUTING WITH TOKEN-VERIFIED FAILOVER
//   The brief ($MAKEFUN_PROMPT_FILE) lists fourteen free OpenRouter models with the house's
//   quality rating (rating_milli) and capabilities (tools, vision, JSON mode). For each prompt
//   this server ranks every free model that meets the prompt's requirements by rating_milli,
//   highest first (ties keep the brief's order), and dials them in that order:
//     non-JSON prompts: thinkingmachines/inkling-2-small (1475) first, then
//       nvidia/nemotron-3.5-super-vl (1303), nemotron-3-ultra-550b (1285),
//       nemotron-3.5-lightning (1221), google/gemma-4-31b (1210), cohere/north-mini-code (1200),
//       then the 1150-rated models in brief order;
//     JSON-mode prompts: only JSON-capable models qualify, so nemotron-3.5-super-vl (1303) leads,
//       then gemma-4-31b (1210), then the JSON-capable 1150s in brief order.
//   That order is the quality column's best play: the scorer credits a prompt with
//   min(rating of the model that really answered, best rating for that prompt), and the best
//   rating per prompt already accounts for capabilities (1303 for the JSON prompts, 1475 for
//   the rest), so serving each prompt with its first candidate earns the full quality bound.
//
// CONCRETE ATTEMPT ORDER, PER PROMPT CLASS (rating_milli in parentheses)
//   JSON-mode (p01, p04 — only json:true models qualify):
//     nemotron-3.5-super-vl (1303) -> gemma-4-31b (1210) -> ernie-5.5-flash (1150) ->
//     dots-3-note (1150) -> gemma-4-26b (1150) -> ling-3.2-flash (1150) -> lfm-3-1.7b (1150)
//     -> particle-1 (1150) -> flint-v1.0 (1150).
//   Plain and tools prompts (p02, p03, p05, p06 — every model qualifies, tools:true on all):
//     inkling-2-small (1475) -> nemotron-3.5-super-vl (1303) -> nemotron-3-ultra-550b (1285)
//     -> nemotron-3.5-lightning (1221) -> gemma-4-31b (1210) -> north-mini-code (1200) ->
//     the eight 1150-rated models in brief order.
//   A model that refused earlier in the trial is demoted behind every not-yet-refused model
//   in the same list, so a later prompt never spends its first call on a model that already
//   proved it cannot answer — unless nothing else is left. Before a model is demoted, though,
//   it gets one immediate retry on the same model when the refusal was transient (429, 5xx,
//   or a fetch error): a transient refusal costs nothing on the tie-break (the scorer counts
//   only successful upstream calls), and a refusal that clears on retry keeps the prompt on
//   its best model instead of dropping it to the next candidate for the whole trial.
//
// FAILOVER — RETRY ONCE ON THE SAME MODEL, THEN SEQUENTIAL, AND A REFUSAL IS REMEMBERED
//   A gateway call answered 4xx/5xx, or a fetch that never completes, is not an answer. When
//   the refusal is transient — 429, any 5xx, or a fetch error — the same model is dialled
//   once more immediately, with no wait (no wall clock is ever read): a 429/5xx refusal
//   carries outcome "upstream_error" in the cassette and is not counted in the tie-break's
//   upstream_calls, so the retry is free there and recovers the best model when the refusal
//   was a one-off. A 400 (model_not_allowed) or 401 (no key) is never retried: it cannot
//   clear on a second dial. A completion that lacks the prompt's token is likewise not
//   retried on the same model — its first successful call already counts in upstream_calls,
//   and a model that did not echo the token tends to repeat itself — so token-missing fails
//   over to the next candidate directly.
//   Only when the same model refuses twice (or refuses once with a non-transient status) is
//   the prompt retried on the next candidate in the ranking, and the model demoted behind
//   every model that has not refused yet for the rest of the trial, only tried again when no
//   fresh candidate remains for a prompt — subject to the per-prompt dial budget: a prompt
//   spends at most MAX_DIALS_PER_PROMPT dials in total, so when the retry itself refuses
//   the prompt ends unserved instead of walking further. The next prompt starts fresh with
//   the demotion state the refusals left behind, so a storm that clears mid-trial still
//   serves the later prompts. Every refusal is recorded as a {status, code,
//   model} row and sent back on the response's `x-makefun-upstream-failures` header (at most
//   8 rows, in refusal order) — the only way the failover column can see a refusal that was
//   retried and then served. Refusals do not count toward the tie-break's upstream_calls
//   (the scorer counts only successful upstream calls), so failing over is cheap; serving
//   with the best model still matters more than saving a call. The trial-wide upstream
//   budget is 60 calls (the trial's cap); this server never spends more, whatever the
//   ranking says.
//
// TOKEN VERIFICATION — NO ANSWER LEAVES WITHOUT ITS PROMPT'S TOKEN
//   Quality is credited only when the provider's own answer body carries the prompt's unique
//   token, so after every successful gateway call this server extracts the completion text
//   and checks the token (taken from the brief's manifest, by arrival order) is in it before
//   answering the env. A completion whose text lacks the token is discarded and the prompt
//   fails over to the next candidate, exactly like a refusal (but it is not reported as one:
//   the gateway did answer). JSON-mode prompts are verified harder: the text must parse as
//   JSON holding the token. A tools prompt whose model returns tool_calls with no text
//   carrying the token fails over the same way. Nothing is ever fabricated: the usage numbers
//   forwarded are the provider's own, and the `model` field on every answer and streamed
//   chunk is the id this server actually dialled.
//
// STREAMING — BUFFER, VERIFY, THEN EMIT, WITH EXACTLY ONE FINISH CHUNK
//   A streaming prompt is dialled with stream:true, but the gateway's SSE is buffered in
//   full before anything is sent to the client: only after the token check passes does this
//   server emit the buffered frames (OpenAI: the frames relayed with the dialled model id;
//   Anthropic: translated through anthropicEventsFromOpenAI over the buffered body). A
//   stream that fails verification never reaches the client, so a bad first model costs one
//   upstream call and never a lost prompt. Buffering stays far under the 30 s/prompt cap.
//   The OpenAI relay also normalises the stream to one finish chunk: super-vl really sends
//   two (one without usage, one with), and the client fails a stream carrying two finish
//   chunks, so frameWithModel nulls the second finish_reason out (usage and
//   native_finish_reason stay). The Anthropic relay already collapses a double finish to
//   one message_stop. Live trials 1-2 each lost their one OpenAI-stream prompt to this
//   (wire 95, served 5/6); the mock's --double-finish mode reproduces it.
//
// THE WIRES
//   POST /v1/chat/completions (OpenAI) and POST /v1/messages (Anthropic), JSON or SSE.
//   Both wires are translated to the gateway's one route, POST $OPENAI_BASE_URL/chat/completions:
//   an Anthropic request is rewritten to Chat Completions first, and the answer is rewritten
//   back. Nothing is ever sent to POST $ANTHROPIC_BASE_URL/v1/messages — the gateway refuses
//   it with 400 for these ids. max_tokens, temperature, tools and the system prompt pass
//   through unchanged. GET /v1/models answers in the shape of the auth header it got
//   (x-api-key means Anthropic, Authorization means OpenAI) with exactly the fourteen free ids.
//   `node main.ts --list` prints the same catalog the register body carries, byte for byte.
//
// DETERMINISM — NO WALL CLOCK, NO RANDOMNESS, AND NO DIAL THAT OUTLIVES ITS PROMPT
//   Routing is a function of the requests and the gateway's answers seen so far (plus which
//   models have refused, which is itself a function of those answers), so a replay with the
//   same brief reproduces the export byte for byte — but only if no dial outlives its prompt.
//   Live trial-0 (2026-11-15) proved the failure mode: a 70-second gateway storm made every
//   dial take ~10 s (the relay's connect timeout), the client's 30 s/prompt cap aborted p01
//   and p02 while their handlers kept dialling as orphans for 50-80 s, and three handlers
//   ran at once sharing the refused-model set. The replay, sequential and instant, demoted
//   ultra before p03 ran, so p03 never dialled it — two cassette entries (p03's ultra dials)
//   were left unconsumed and the trial was void. The dial order between concurrent handlers
//   was pure wall-clock luck (p03's ultra dial beat p02's ultra retry by 37 ms).
//   The fix is a bound, not a hope: MAX_DIALS_PER_PROMPT = 2 and DIAL_TIMEOUT_MS = 12000 mean
//   one prompt's whole walk takes at most 2 x 12 s = 24 s, always inside the client's 30 s
//   cap, so a handler can never be orphaned and handlers can never overlap. Prompts are
//   also served strictly one at a time, in arrival order (a FIFO chain around serve), as
//   defence in depth for any path the bound does not cover. A wall-clock TIME budget would
//   not do: live and replay measure different seconds, so a time cut would take different
//   dials in each pass; a dial COUNT is the same in both. Retry-once is kept (it is what
//   saved p03 live, lightning 502 -> 200 as the storm cleared); retrying a third time is
//   not: in the storm every model refused twice in a row, so a third dial would still be a
//   refusal, and 3 x 12 s = 36 s would break the 30 s cap again.
//
// TRIAL SHAPE
//   Listen on 0.0.0.0 at a free port, POST $MAKEFUN_ENV_URL/register {protocol_version: 1,
//   port, catalog}, serve the six prompts one at a time, poll GET /work every 100 ms and
//   exit 0 the moment it says done. A process still running when the wall ends scores zero,
//   so nothing is ever waited on beyond that poll.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCatalog,
  capabilitiesOf,
  freeModels,
  isRecord,
  meetsRequirements,
  readBrief,
  type CatalogReport,
  type Json,
  type ModelRow,
  type Requirement,
} from './lib/providers.ts';
import {
  anthropicError,
  anthropicEventsFromOpenAI,
  anthropicModelList,
  anthropicToOpenAI,
  openAIError,
  openAIJsonWithModel,
  openAIModelList,
  openAIStreamWithModel,
  openAIToAnthropic,
  type ServedModel,
} from './lib/wire.ts';

/** The wire protocol's version, in the register body. */
const PROTOCOL_VERSION = 1;
/** How often GET /work is polled, in milliseconds. */
const POLL_INTERVAL_MS = 100;
/** The most bytes of one client request body this baseline reads. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The trial's cap on gateway calls: this server never spends more in one trial. */
const MAX_UPSTREAM_CALLS = 60;
/**
 * The most upstream dials one prompt may spend, counting the first dial and its same-model
 * retry together: a prompt that still refuses after its retry ends unserved instead of
 * walking the ranking. Two is the whole point of the number — see DETERMINISM.
 */
const MAX_DIALS_PER_PROMPT = 2;
/**
 * One gateway dial may not hang past this; a hung call is a refusal like any other. Twelve
 * seconds sits just above the relay's own connect timeout (its 502 arrives at ~10 s), so a
 * refusal the cassette records is always one this server actually received, while two hung
 * dials (2 x 12 s) still finish inside the client's 30 s/prompt budget.
 */
const DIAL_TIMEOUT_MS = 12000;
/** The most refusal rows the failures header carries, in refusal order. */
const MAX_FAILURE_ROWS = 8;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const GATEWAY_URL = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
/** The trial's dummy key for the entry's gateway lane; the gateway swaps it for the entrant's own key. */
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

const brief = readBrief(PROMPT_FILE);
const catalog: CatalogReport = buildCatalog(brief);
/** Which prompt row the request now arriving is: the brief's prompts are in the client's arrival order. */
let manifestIndex = 0;
/** Gateway calls spent so far in this trial, against the 60-call cap. */
let upstreamCalls = 0;
/** Models that have refused a gateway call (4xx/5xx/fetch error) in this trial, in refusal order. */
const refusedModels = new Set<string>();

function log(message: string): void {
  process.stderr.write(`aggregator: ${message}\n`);
}

/**
 * The gateway's Chat Completions route. OPENAI_BASE_URL is the OpenAI-compatible root (`…/v1` on the
 * trial network); a base that does not already end in `/v1` gets one, so both spellings reach the route.
 */
function chatCompletionsUrl(): string {
  if (GATEWAY_URL === '') return '';
  return GATEWAY_URL.endsWith('/v1') ? `${GATEWAY_URL}/chat/completions` : `${GATEWAY_URL}/v1/chat/completions`;
}

/** The free models the brief lists, as GET /v1/models names them. */
function servedModels(): ServedModel[] {
  return freeModels(brief).map((model) => ({ id: model.id, provider: model.provider, display_name: model.display_name }));
}

/**
 * The candidates for one prompt's requirements, best first: every free model that meets them,
 * ranked by the brief's rating_milli descending, ties in the brief's order, with models that
 * have refused a call in this trial demoted behind every model that has not refused yet.
 * A refused model is only reached again when no fresh candidate remains.
 */
function candidatesFor(requires: Requirement): ModelRow[] {
  const ranked = freeModels(brief)
    .filter((model) => meetsRequirements(requires, capabilitiesOf(model)))
    .sort((a, b) => b.rating_milli - a.rating_milli);
  const fresh = ranked.filter((model) => !refusedModels.has(model.id));
  const refused = ranked.filter((model) => refusedModels.has(model.id));
  return [...fresh, ...refused];
}

/** One refusal row for the failures header: the gateway's status, its error code, the model dialled. */
interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

/** The gateway's error code from its error body, or '' when the body names none. */
function codeOfUpstreamError(text: string): string {
  if (text === '') return '';
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !isRecord(value.error)) return '';
    const error = value.error;
    if (typeof error.code === 'string' && error.code !== '') return error.code.slice(0, 64);
    if (typeof error.type === 'string' && error.type !== '') return error.type.slice(0, 64);
    return '';
  } catch {
    return '';
  }
}

/** The requirements of the prompt now arriving: the brief's row by arrival order, else the body's own. */
function requirementsFor(body: Json): Requirement {
  const entry = brief.prompts[manifestIndex];
  if (entry !== undefined) return entry.requires;
  return requirementsFromBody(body);
}

/** The token of the prompt now arriving: the brief's row by arrival order, else a token read off the body. */
function tokenFor(body: Json): string {
  const entry = brief.prompts[manifestIndex];
  if (entry !== undefined && entry.token !== '') return entry.token;
  return tokenFromBody(body);
}

/** Advance the arrival counter once the prompt now arriving has been read. */
function consumeManifestRow(): void {
  manifestIndex += 1;
}

/** A token-shaped word (SPARROW-7435) in a request body's text, or '' when there is none. */
function tokenFromBody(body: Json): string {
  const texts: string[] = [];
  if (typeof body.system === 'string') texts.push(body.system);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === 'string') texts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && typeof block.text === 'string') texts.push(block.text);
      }
    }
  }
  for (const text of texts) {
    const match = /[A-Z][A-Z0-9]*-[0-9]{4,}/.exec(text);
    if (match !== null) return match[0];
  }
  return '';
}

/** Requirements read off a request body, when the brief has no row for it. */
function requirementsFromBody(body: Json): Requirement {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let vision = false;
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && (block.type === 'image' || block.type === 'image_url')) vision = true;
    }
  }
  const format = isRecord(body.response_format) ? body.response_format.type : undefined;
  return { tools: Array.isArray(body.tools) && body.tools.length > 0, vision, json: format === 'json_object' || format === 'json_schema' };
}

/** The text of a Chat Completions answer's message: its content string, or its text blocks joined. */
function openAITextOf(answer: Json): string {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n');
  }
  return '';
}

/** The text of a Chat Completions SSE body: every delta's content joined, in frame order. */
function openAISSETextOf(sse: string): string {
  const parts: string[] = [];
  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '' || payload === '[DONE]') continue;
    try {
      const chunk: unknown = JSON.parse(payload);
      if (!isRecord(chunk)) continue;
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === 'string') parts.push(delta.content);
    } catch {
      // A frame that is not JSON carries no text: skip it.
    }
  }
  return parts.join('');
}

/** The text of an Anthropic Messages answer: its text blocks joined. */
function anthropicTextOf(answer: Json): string {
  const content = answer.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
      .join('\n');
  }
  return '';
}

/**
 * Whether a completion's text serves its prompt: the prompt's token must be in the text, and a
 * JSON-mode prompt's text must parse as JSON holding the token. A text that carries no token
 * earns the prompt nothing, so it is discarded and the prompt fails over — never answered.
 */
function textServes(text: string, token: string, jsonRequired: boolean): boolean {
  if (token === '') return text !== '';
  if (!text.includes(token)) return false;
  if (!jsonRequired) return true;
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return JSON.stringify(parsed).includes(token);
  } catch {
    return false;
  }
}

/** A buffered body as a one-shot ReadableStream, for the wire's stream relays. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * One Chat Completions answer as the SSE a streaming client expects: a single content chunk
 * carrying the answer's text, its finish reason, and its usage when present, then [DONE].
 * Only used when a gateway answers a streaming request with plain JSON instead of SSE.
 */
function sseFromJsonAnswer(answer: Json, model: string): string {
  const choices = Array.isArray(answer.choices) ? answer.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const text = openAITextOf(answer);
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop';
  const id = typeof answer.id === 'string' ? answer.id : 'chatcmpl-aggregate';
  const usage = isRecord(answer.usage) ? answer.usage : null;
  const frames: string[] = [
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: finish }], ...(usage !== null ? { usage } : {}) })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return frames.join('');
}

/** The failures header's value for this request's refusals, or null when there were none. */
function failuresHeader(failures: FailureRow[]): string | null {
  if (failures.length === 0) return null;
  return JSON.stringify(failures.slice(0, MAX_FAILURE_ROWS));
}

/** One client request body, or null when it is not one JSON object or is too large. */
async function readJson(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extraHeaders });
  res.end(text);
}

function sendError(res: ServerResponse, wire: 'openai' | 'anthropic', status: number, type: string, message: string, extraHeaders: Record<string, string> = {}): void {
  if (wire === 'anthropic') sendJson(res, status, anthropicError(type, message), extraHeaders);
  else sendJson(res, status, openAIError(message, type, null), extraHeaders);
}

/** GET /v1/models, in the shape of the auth header the client sent. */
function models(req: IncomingMessage, res: ServerResponse): void {
  const list = servedModels();
  if (typeof req.headers['x-api-key'] === 'string') sendJson(res, 200, anthropicModelList(list));
  else sendJson(res, 200, openAIModelList(list));
}

/** POST one request to the gateway's Chat Completions route, naming the model this entry dialled. */
async function dial(model: string, body: Json): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (body.stream === true) headers.accept = 'text/event-stream';
  return fetch(chatCompletionsUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, model }),
    signal: AbortSignal.timeout(DIAL_TIMEOUT_MS),
  });
}

/**
 * Serve one prompt on one wire: dial the ranked candidates in order until one answers with a
 * completion whose text carries the prompt's token, then emit that completion on the client's
 * wire. A transient refusal (429, 5xx, fetch error) is retried once on the same model before
 * the prompt moves to the next candidate; other refusals move on at once. Every refusal is
 * reported on the failures header; completions that lack the token are discarded and retried
 * on the next candidate, without a header row and without a same-model retry.
 */
async function serve(req: IncomingMessage, res: ServerResponse, wire: 'openai' | 'anthropic'): Promise<void> {
  const body = await readJson(req);
  if (body === null) return sendError(res, wire, 400, 'invalid_request_error', 'the request body is not one JSON object');
  const requires = requirementsFor(body);
  const token = tokenFor(body);
  consumeManifestRow();
  const jsonRequired = requires.json === true;
  const stream = body.stream === true;
  const candidates = candidatesFor(requires);
  if (candidates.length === 0) {
    return sendError(res, wire, 503, wire === 'anthropic' ? 'overloaded_error' : 'no_free_model', 'no free model in the brief meets this request');
  }
  const failures: FailureRow[] = [];
  // Dials spent on this prompt, first dial and same-model retry together: the walk ends
  // when the budget is spent, even mid-ranking (see DETERMINISM — a prompt's whole walk
  // must finish inside the client's 30 s/prompt cap, or its handler outlives the prompt
  // and the replay diverges).
  let dials = 0;
  for (const candidate of candidates) {
    if (dials >= MAX_DIALS_PER_PROMPT || upstreamCalls >= MAX_UPSTREAM_CALLS) break;
    const upstreamBody: Json = wire === 'openai' ? { ...body, model: candidate.id } : anthropicToOpenAI(body, candidate.id);
    // One candidate, up to two dials: the first dial, plus one immediate same-model retry
    // when the first refusal was transient (429, 5xx, or a fetch error). A 400/401 refusal
    // is not retried, and a model that still refuses after the retry is demoted for the
    // rest of the trial; a model whose retry succeeds is not demoted at all.
    let upstream: Response | null = null;
    let refused = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (dials >= MAX_DIALS_PER_PROMPT || upstreamCalls >= MAX_UPSTREAM_CALLS) break;
      let response: Response;
      try {
        dials += 1;
        upstreamCalls += 1;
        response = await dial(candidate.id, upstreamBody);
      } catch (err) {
        failures.push({ status: 504, code: 'fetch_error', model: candidate.id });
        log(`dial ${candidate.id} failed to reach the gateway: ${(err as Error).message}`);
        refused = true;
        if (attempt === 0) continue; // fetch error: retry the same model once
        break;
      }
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => '');
        failures.push({ status: response.status, code: codeOfUpstreamError(text), model: candidate.id });
        log(`gateway refused ${candidate.id} with HTTP ${response.status}`);
        refused = true;
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) continue; // transient refusal: retry the same model once
        break;
      }
      upstream = response;
      refused = false;
      break;
    }
    if (upstream === null) {
      if (refused) refusedModels.add(candidate.id);
      continue;
    }
    const raw = await upstream.text();
    if (stream) {
      // Buffer the whole SSE body, verify the token, and only then emit it.
      let sse = raw;
      let text = openAISSETextOf(sse);
      if (text === '' && sse.trim() !== '' && !sse.includes('data:')) {
        // The gateway answered a streaming request with plain JSON: extract its text and
        // re-emit it as SSE, so the client still gets the stream it asked for.
        try {
          const answer: unknown = JSON.parse(sse);
          if (isRecord(answer)) {
            sse = sseFromJsonAnswer(answer, candidate.id);
            text = openAITextOf(answer);
          }
        } catch {
          // Not JSON either: the body carries no text, so it cannot serve.
        }
      }
      if (!textServes(text, token, jsonRequired)) {
        log(`completion from ${candidate.id} carries no token; failing over`);
        continue;
      }
      const headers: Record<string, string> = {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      };
      const trail = failuresHeader(failures);
      if (trail !== null) headers['x-makefun-upstream-failures'] = trail;
      res.writeHead(200, headers);
      try {
        if (wire === 'openai') {
          for await (const frame of openAIStreamWithModel(streamOf(sse), candidate.id)) res.write(frame);
        } else {
          for await (const event of anthropicEventsFromOpenAI(streamOf(sse), candidate.id)) res.write(event);
        }
      } finally {
        res.end();
      }
      return;
    }
    let answer: unknown;
    try {
      answer = JSON.parse(raw);
    } catch {
      log(`completion from ${candidate.id} is not JSON; failing over`);
      continue;
    }
    if (!isRecord(answer)) {
      log(`completion from ${candidate.id} is not one JSON object; failing over`);
      continue;
    }
    // The gateway always answers in Chat Completions shape, on both client wires.
    const text = openAITextOf(answer);
    if (!textServes(text, token, jsonRequired)) {
      log(`completion from ${candidate.id} carries no token; failing over`);
      continue;
    }
    const trail = failuresHeader(failures);
    const extra: Record<string, string> = trail !== null ? { 'x-makefun-upstream-failures': trail } : {};
    if (wire === 'openai') sendJson(res, 200, openAIJsonWithModel(answer, candidate.id), extra);
    else sendJson(res, 200, openAIToAnthropic(answer, candidate.id), extra);
    return;
  }
  // Every candidate refused, answered without the token, or the call budget ran out.
  const trail = failuresHeader(failures);
  const extra: Record<string, string> = trail !== null ? { 'x-makefun-upstream-failures': trail } : {};
  if (wire === 'anthropic') {
    sendError(res, wire, 502, 'api_error', 'the gateway refused every free model that meets this request', extra);
  } else {
    sendError(res, wire, 502, 'upstream_error', 'the gateway refused every free model that meets this request', extra);
  }
}

/** POST /v1/chat/completions: an OpenAI-shaped client, answered by the best free model that serves it. */
async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await serveSerialized(req, res, 'openai');
}

/** POST /v1/messages: an Anthropic-shaped client, rewritten to Chat Completions and answered back. */
async function messages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await serveSerialized(req, res, 'anthropic');
}

/**
 * Prompts are served strictly one at a time, in arrival order: a prompt's handler runs only
 * after the previous prompt's handler has finished, so two handlers can never share the
 * refused-model set or the manifest counter at once. With the per-prompt dial budget the
 * chain is normally empty — a handler finishes inside its 30 s window, before the client
 * sends the next prompt — so this is defence in depth for any path the bound does not
 * cover. The chain itself never rejects, so one prompt's failure cannot stall the next.
 * GET /v1/models is not serialised: it carries no prompt state and must answer at once.
 */
let serveChain: Promise<void> = Promise.resolve();
function serveSerialized(req: IncomingMessage, res: ServerResponse, wire: 'openai' | 'anthropic'): Promise<void> {
  const run = serveChain.then(() => serve(req, res, wire));
  serveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    models(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    await chat(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    await messages(req, res);
    return;
  }
  sendError(res, url.pathname === '/v1/messages' ? 'anthropic' : 'openai', 404, 'not_found', `no route ${req.method ?? ''} ${url.pathname}`);
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** POST /register with the port and the one catalog; the env answers with the trial's prompt count. */
async function register(port: number, report: CatalogReport): Promise<void> {
  const res = await fetch(`${ENV_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol_version: PROTOCOL_VERSION, port, catalog: report }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`POST ${ENV_URL}/register answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reply: unknown = await res.json();
  if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: the trial holds ${reply.requests} prompts`);
}

/** Poll GET /work every 100 ms; exit 0 the moment it says done. */
function poll(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status !== 200) return;
        const work: unknown = await res.json();
        if (isRecord(work) && work.done === true) {
          clearInterval(timer);
          server.close();
          process.exit(0);
        }
      } catch {
        // The env is not reachable yet: try again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, POLL_INTERVAL_MS);
}

async function start(): Promise<void> {
  if (brief.error !== null) log(brief.error);
  if (process.argv.includes('--list')) {
    // The same document the register body carries, byte for byte: print the one built object and stop
    // before any server starts. A process whose stdout is not flushed loses the tail, so wait for it.
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (chatCompletionsUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendError(res, req.url?.startsWith('/v1/messages') === true ? 'anthropic' : 'openai', 500, 'internal_error', 'the server failed to answer');
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  const port = address.port;
  // 8080 is the env's on one layout; the OS's ephemeral range never holds it, and the guard says so.
  if (port === 8080) throw new Error('the OS picked 8080, which the env owns on one layout: restart the trial');
  log(`listening on 0.0.0.0:${port} with ${servedModels().length} free models`);
  await register(port, catalog);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  poll(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
