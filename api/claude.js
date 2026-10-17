// ─────────────────────────────────────────────────────────────────────────────
// Resolve's AI function — one endpoint that works with any AI provider.
//
//   POST /api/claude          { system, messages, maxTokens }  →  { text, provider, model }
//   GET  /api/claude          →  which providers are set up (never shows keys)
//   GET  /api/claude?test=1   →  makes one tiny real call and shows the exact result
//
// Keys go in Vercel → your project → Settings → Environment Variables. Set any of:
//   NVIDIA_API_KEY     free key from build.nvidia.com
//   ANTHROPIC_API_KEY  Anthropic (Claude)
//   OPENAI_API_KEY     OpenAI
//   AI_API_KEY         any other provider. Keys that start with gsk_ (Groq), sk-or- (OpenRouter),
//                      AIza (Gemini) or xai- (xAI) are recognised automatically; for anything else
//                      also set AI_BASE_URL (and AI_MODEL).
//
// If more than one is set they're tried in the order Anthropic → OpenAI → NVIDIA → AI_API_KEY,
// and when one is unusable (no credit, bad key, overloaded…) the next one answers instead.
// AI_PROVIDER=nvidia (or anthropic, openai, groq…) puts that provider first.
// Optional: ANTHROPIC_MODEL, OPENAI_MODEL, NVIDIA_MODEL, NVIDIA_VISION_MODEL, AI_MODEL, AI_PROVIDER_NAME.
//
// Every failure comes back as JSON with a specific `code` and a plain-language `error`.
// ─────────────────────────────────────────────────────────────────────────────

export const config = { maxDuration: 60 };

const VERSION = "2";
const DEFAULT_BUDGET_MS = 52_000; // total time for one request, kept under maxDuration
const FIRST_ATTEMPT_CAP_MS = 25_000; // when another provider is waiting as a backup
const MAX_OUTPUT_TOKENS = 4096;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/* ───────────────────────────── helpers ───────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readEnv = (name) => (typeof process.env[name] === "string" ? process.env[name].trim() : "");

// Keys pasted into Vercel often arrive wrapped in quotes or with a "Bearer " prefix.
function readSecret(name) {
  let value = readEnv(name);
  if (value.length > 1 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
  return value.replace(/^Bearer\s+/i, "");
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function tidy(text, max = 300) {
  return String(text == null ? "" : text).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function scrub(text, secret) {
  return secret && secret.length >= 8 ? text.split(secret).join("[key hidden]") : text;
}

function send(res, status, payload, pretty = false) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, pretty ? 2 : 0));
}

/* ───────────────────────────── providers ───────────────────────────── */

// Recognised key families — so a single AI_API_KEY is enough for these.
// (Order matters: "sk-ant-" and "sk-or-" must be checked before plain "sk-".)
const KEY_FAMILIES = [
  { prefix: "sk-ant-", id: "anthropic", label: "Anthropic", style: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5", billing: "console.anthropic.com/settings/billing" },
  { prefix: "nvapi-", id: "nvidia", label: "NVIDIA Build", style: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct", visionModel: "meta/llama-3.2-90b-vision-instruct", billing: "build.nvidia.com" },
  { prefix: "sk-or-", id: "custom", label: "OpenRouter", style: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", billing: "openrouter.ai/credits" },
  { prefix: "gsk_", id: "custom", label: "Groq", style: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", billing: "console.groq.com" },
  { prefix: "AIza", id: "custom", label: "Google Gemini", style: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "", billing: "aistudio.google.com" },
  { prefix: "xai-", id: "custom", label: "xAI", style: "openai", baseUrl: "https://api.x.ai/v1", model: "", billing: "console.x.ai" },
  { prefix: "sk-", id: "openai", label: "OpenAI", style: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", billing: "platform.openai.com/settings/organization/billing" },
];
const familyById = (id) => KEY_FAMILIES.find((f) => f.id === id);

function makeProvider({ id, family, apiKey, keyVar, modelVar, baseVar, visionVar, label }) {
  const baseUrl = readEnv(baseVar).replace(/\/+$/, "") || (family && family.baseUrl) || "";
  const model = readEnv(modelVar) || (family && family.model) || "";
  const visionModel = (visionVar && readEnv(visionVar)) || (family && family.visionModel) || "";
  const provider = {
    id,
    label: label || (family && family.label) || hostOf(baseUrl) || "AI provider",
    style: (family && family.style) || "openai",
    apiKey,
    keyVar,
    modelVar,
    baseVar,
    visionVar: visionVar || "",
    baseUrl,
    model,
    visionModel,
    billing: (family && family.billing) || "",
    problem: "",
  };
  if (!baseUrl) {
    provider.problem = `${keyVar} is set, but I can't tell which provider that key belongs to. Also set ${baseVar} (for example https://api.groq.com/openai/v1) and ${modelVar}.`;
  } else if (!model) {
    provider.problem = `${keyVar} is set for ${provider.label}, but no model is chosen. Set ${modelVar} to the model you want to use.`;
  }
  return provider;
}

function buildProviders() {
  const providers = [];
  const seenKeys = new Set();
  const add = (provider) => {
    if (seenKeys.has(provider.apiKey)) return; // same key pasted into two variables
    seenKeys.add(provider.apiKey);
    providers.push(provider);
  };

  const anthropicKey = readSecret("ANTHROPIC_API_KEY");
  if (anthropicKey) add(makeProvider({ id: "anthropic", family: familyById("anthropic"), apiKey: anthropicKey, keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", baseVar: "ANTHROPIC_BASE_URL" }));

  const openaiKey = readSecret("OPENAI_API_KEY");
  if (openaiKey) add(makeProvider({ id: "openai", family: familyById("openai"), apiKey: openaiKey, keyVar: "OPENAI_API_KEY", modelVar: "OPENAI_MODEL", baseVar: "OPENAI_BASE_URL" }));

  const nvidiaKey = readSecret("NVIDIA_API_KEY");
  if (nvidiaKey) add(makeProvider({ id: "nvidia", family: familyById("nvidia"), apiKey: nvidiaKey, keyVar: "NVIDIA_API_KEY", modelVar: "NVIDIA_MODEL", baseVar: "NVIDIA_BASE_URL", visionVar: "NVIDIA_VISION_MODEL" }));

  const anyKey = readSecret("AI_API_KEY");
  if (anyKey) {
    const family = KEY_FAMILIES.find((f) => anyKey.startsWith(f.prefix)) || null;
    add(makeProvider({ id: "custom", family, apiKey: anyKey, keyVar: "AI_API_KEY", modelVar: "AI_MODEL", baseVar: "AI_BASE_URL", visionVar: "AI_VISION_MODEL", label: readEnv("AI_PROVIDER_NAME") }));
  }

  const preferred = readEnv("AI_PROVIDER").toLowerCase();
  if (preferred) {
    const matches = (p) => p.id === preferred || p.label.toLowerCase().includes(preferred);
    providers.sort((a, b) => Number(matches(b)) - Number(matches(a))); // stable: others keep their order
  }
  return providers;
}

const MISSING_KEY_MESSAGE =
  "No AI provider is set up yet. In Vercel → your project → Settings → Environment Variables, add NVIDIA_API_KEY (free key from build.nvidia.com), ANTHROPIC_API_KEY, OPENAI_API_KEY, or AI_API_KEY for any other provider — then redeploy.";

/* ───────────────────────────── request shaping ───────────────────────────── */

// The frontend speaks one neutral format — { role, content } where content is a string or a list of
// { type: "text", text } / { type: "image", mediaType, data } blocks. This checks it and tidies it up.
function normalizeMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: "Missing messages — send at least one message." };
  const messages = [];
  let hasImages = false;

  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    const where = `Message ${i + 1}`;
    if (!m || (m.role !== "user" && m.role !== "assistant")) return { error: `${where} has no valid role (it must be "user" or "assistant").` };

    let blocks;
    if (typeof m.content === "string") blocks = [{ type: "text", text: m.content }];
    else if (Array.isArray(m.content)) blocks = m.content;
    else return { error: `${where} has no content.` };

    const clean = [];
    for (const block of blocks) {
      if (block && block.type === "text" && typeof block.text === "string") {
        if (block.text.trim()) clean.push({ type: "text", text: block.text });
      } else if (block && block.type === "image" && m.role === "user") {
        if (!IMAGE_TYPES.has(block.mediaType)) return { error: `${where}: only JPEG, PNG, GIF or WebP images can be read (this one is ${block.mediaType || "an unknown type"}).` };
        if (typeof block.data !== "string" || !block.data) return { error: `${where}: the attached image has no data.` };
        clean.push({ type: "image", mediaType: block.mediaType, data: block.data });
        hasImages = true;
      } else {
        return { error: `${where} contains something that isn't text or an image.` };
      }
    }
    if (clean.length === 0) return { error: `${where} is empty.` };

    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push(...clean); // two in a row from the same side → one message
    else messages.push({ role: m.role, content: clean });
  }

  while (messages.length && messages[0].role !== "user") messages.shift(); // every provider wants to start with the user
  if (messages.length === 0) return { error: "There's no user message to answer." };
  return { messages, hasImages };
}

function clampTokens(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1000;
  return Math.min(n, MAX_OUTPUT_TOKENS);
}

function toAnthropicBody(model, { system, messages, maxTokens }) {
  return {
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: messages.map((m) => ({
      role: m.role,
      content:
        m.content.length === 1 && m.content[0].type === "text"
          ? m.content[0].text
          : m.content.map((b) =>
              b.type === "image" ? { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } } : { type: "text", text: b.text }
            ),
    })),
  };
}

function toOpenAIBody(model, { system, messages, maxTokens }) {
  const chat = [];
  if (system) chat.push({ role: "system", content: system });
  for (const m of messages) {
    const textOnly = m.content.every((b) => b.type === "text");
    chat.push({
      role: m.role,
      // Plain text stays a plain string — the most widely accepted shape. Images need the list form.
      content: textOnly
        ? m.content.map((b) => b.text).join("\n\n")
        : m.content.map((b) => (b.type === "image" ? { type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } } : { type: "text", text: b.text })),
    });
  }
  return { model, max_tokens: maxTokens, messages: chat };
}

/* ───────────────────────────── errors ───────────────────────────── */

const BRIEF = {
  insufficient_credits: "out of credit",
  invalid_key: "API key rejected",
  permission_denied: "access refused for this key",
  region_blocked: "region not allowed",
  model_not_found: "model not available",
  endpoint_not_found: "address not found",
  rate_limited: "rate-limited",
  overloaded: "overloaded",
  server_error: "server error",
  timeout: "timed out",
  upstream_unreachable: "couldn't connect",
  request_too_large: "request too large",
  context_too_long: "conversation too long",
  bad_request: "request rejected",
  content_blocked: "declined to answer",
  empty: "empty answer",
  bad_response: "unreadable reply",
  missing_config: "not fully set up",
  unknown: "unexpected error",
};

const HTTP_STATUS = {
  insufficient_credits: 402,
  rate_limited: 429,
  overloaded: 503,
  timeout: 504,
  request_too_large: 413,
  context_too_long: 413,
  bad_request: 400,
  content_blocked: 422,
  missing_config: 503,
  missing_key: 503,
};

const RETRYABLE = new Set(["overloaded", "server_error", "rate_limited", "upstream_unreachable"]);
const NO_FALLBACK = new Set(["bad_request", "request_too_large", "context_too_long", "content_blocked"]); // the request itself is the problem
const NO_QUOTE = new Set(["empty", "timeout", "upstream_unreachable", "bad_response", "missing_config"]);

function plainSentence(code, p, model, c) {
  const P = p.label;
  const modelVar = c.usedVision ? p.visionVar || p.modelVar : p.modelVar;
  switch (code) {
    case "insufficient_credits":
      return p.id === "nvidia"
        ? `${P} says the free credits on this key are used up. Check your balance at build.nvidia.com, or create a new key.`
        : `${P} says this account is out of credit${p.billing ? ` — add some at ${p.billing}` : ""}.`;
    case "invalid_key":
      return `${P} rejected the API key — it may be mistyped, revoked, or from a different provider. Check ${p.keyVar} in Vercel → Settings → Environment Variables, then redeploy.`;
    case "permission_denied":
      return `${P} refused this key access to “${model}”. Pick a model your account can use (set ${modelVar}).`;
    case "region_blocked":
      return `${P} doesn't allow requests from the region this server runs in.`;
    case "model_not_found":
      return `${P} has no model called “${model}” available to this key. Set ${modelVar} to one that exists.`;
    case "endpoint_not_found":
      return `${P} didn't recognise the address ${p.baseUrl}. Check ${p.baseVar}.`;
    case "rate_limited":
      return `${P} is rate-limiting this key (too many requests). Wait ${c.retryAfterMs ? `${Math.ceil(c.retryAfterMs / 1000)} seconds` : "a few seconds"} and try again.`;
    case "overloaded":
      return `${P} is overloaded right now. Try again in a moment.`;
    case "server_error":
      return `${P}'s servers hit an error${c.status ? ` (HTTP ${c.status})` : ""}. That's on their side — try again shortly.`;
    case "timeout":
      return c.afterMs ? `${P} took too long to answer — gave up after ${Math.max(1, Math.round(c.afterMs / 1000))} seconds. Try again.` : `${P} took too long to answer. Try again.`;
    case "upstream_unreachable":
      return `Couldn't connect to ${P}${c.reason ? ` — ${c.reason}` : ""}. Try again shortly.`;
    case "request_too_large":
      return `That request is too big for ${P}. Remove the image or start a new chat.`;
    case "context_too_long":
      return `This conversation is too long for ${P}'s model. Start a new chat for this case.`;
    case "bad_request":
      return `${P} rejected the request as invalid.`;
    case "content_blocked":
      return `${P} declined to answer this one. Try rewording the request.`;
    case "empty":
      return `${P} answered with an empty message. Try again.`;
    case "bad_response":
      return `${P} sent back something that isn't valid JSON, so it couldn't be read.`;
    default:
      return `${P} returned an unexpected error${c.status ? ` (HTTP ${c.status})` : ""}.`;
  }
}

function failure(p, model, code, ctx = {}) {
  const sentence = plainSentence(code, p, model, ctx);
  const quoted = ctx.detail && !NO_QUOTE.has(code) ? ` ${p.label} said: “${ctx.detail}”` : "";
  const brief = BRIEF[code] || BRIEF.unknown;
  return {
    ok: false,
    code,
    provider: p.label,
    model,
    upstreamStatus: ctx.status || undefined,
    message: scrub(sentence + quoted, p.apiKey),
    brief: ctx.status ? `${brief} (HTTP ${ctx.status})` : brief,
    status: HTTP_STATUS[code] || 502,
    retryable: RETRYABLE.has(code) && !(code === "rate_limited" && ctx.retryAfterMs > 2500),
    fallback: !NO_FALLBACK.has(code),
    retryAfterMs: ctx.retryAfterMs,
  };
}

function extractMessage(data, raw) {
  if (data && typeof data === "object") {
    const e = data.error;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) return data.detail.map((d) => (d && (d.msg || d.message)) || JSON.stringify(d)).join("; ");
    if (typeof data.message === "string") return data.message;
    if (typeof data.title === "string") return data.title;
  }
  return raw;
}

// Turns "the provider said no" (HTTP status + whatever body it sent) into one of our specific codes.
function classifyHttpError(status, data, raw, headers) {
  const message = tidy(extractMessage(data, raw));
  const msg = message.toLowerCase();
  const e = data && typeof data === "object" && data.error && typeof data.error === "object" ? data.error : {};
  const kind = `${e.type || ""} ${e.code || ""} ${data && typeof data === "object" && typeof data.type === "string" && data.type !== "error" ? data.type : ""}`.toLowerCase();

  const retryAfter = Number(headers && headers.get ? headers.get("retry-after") : NaN);
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
  const ctx = { status, detail: message, retryAfterMs };

  let code;
  if (status === 402 || /billing_error|insufficient_quota|billing_hard_limit/.test(kind) || /credit balance|insufficient (funds|credits?|balance|quota)|payment required|out of credits?|(credits?|balance) (has |have )?(expired|run out|been exhausted|exhausted|depleted)|exceeded your current quota/.test(msg)) {
    code = "insufficient_credits";
  } else if (status === 401 || /authentication_error|invalid_api_key|unauthenticated/.test(kind) || /invalid[ _-]*api[ _-]*key|incorrect api key|api key not valid|invalid x-api-key|authentication failed|unauthorized|invalid bearer/.test(msg)) {
    code = "invalid_key";
  } else if (status === 403) {
    code = /country|region|territory|location/.test(msg) ? "region_blocked" : "permission_denied";
  } else if (status === 404 || /not_found_error/.test(kind)) {
    code = data ? "model_not_found" : "endpoint_not_found";
  } else if ((status === 400 || status === 422) && (/model[^.]{0,80}(not found|does not exist|doesn't exist|unknown|not available)|(unknown|invalid|no such) model|do(es)? not have access to (the )?model/.test(msg) || /model_not_found/.test(kind))) {
    code = "model_not_found";
  } else if (status === 408 || status === 504 || /timeout_error/.test(kind)) {
    code = "timeout";
  } else if (status === 413 || /request_too_large/.test(kind) || /payload too large|request (body )?(is )?too large|exceeds the maximum (allowed )?(request )?size|image[^.]{0,40}(too large|exceeds)/.test(msg)) {
    code = "request_too_large";
  } else if ((status === 400 || status === 422) && (/context_length_exceeded/.test(kind) || /context[ _-]*(length|window)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|token limit/.test(msg))) {
    code = "context_too_long";
  } else if (status === 429 || /rate_limit/.test(kind)) {
    code = "rate_limited";
  } else if (status === 529 || /overloaded/.test(kind) || /overloaded/.test(msg)) {
    code = "overloaded";
  } else if (status >= 500) {
    code = "server_error";
  } else if (status === 400 || status === 422) {
    code = "bad_request";
  } else {
    code = "unknown";
  }
  return { code, ctx };
}

function describeNetworkError(err) {
  const cause = err && err.cause;
  const code = String((cause && (cause.code || cause.errno)) || (err && err.code) || "");
  const known = {
    ENOTFOUND: "its address couldn't be found (DNS lookup failed)",
    EAI_AGAIN: "DNS lookup failed",
    ECONNREFUSED: "the connection was refused",
    ECONNRESET: "the connection was dropped",
    EPIPE: "the connection was dropped",
    ETIMEDOUT: "the connection timed out",
    UND_ERR_CONNECT_TIMEOUT: "the connection timed out",
    UND_ERR_SOCKET: "the connection closed unexpectedly",
    UND_ERR_HEADERS_TIMEOUT: "it never started answering",
  };
  if (known[code]) return known[code];
  if (/CERT|SSL|TLS/i.test(code)) return `a secure-connection problem (${code})`;
  return tidy((cause && cause.message) || (err && err.message) || "network error", 160);
}

/* ───────────────────────────── calling a provider ───────────────────────────── */

// Some models (DeepSeek-R1 style) write their thinking inside <think>…</think> before the answer. The advisor
// should only see the answer — and a reply that is nothing but unfinished thinking counts as empty.
function stripReasoning(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>/i, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

async function postJson(url, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
    const raw = await res.text(); // inside the timer, so a stalled body also times out
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    return { res, raw, data };
  } finally {
    clearTimeout(timer);
  }
}

function fromErrorResponse(p, model, usedVision, { res, raw, data }) {
  const { code, ctx } = classifyHttpError(res.status, data, raw, res.headers);
  return failure(p, model, code, { ...ctx, usedVision });
}

async function callAnthropic(p, model, usedVision, payload, timeoutMs) {
  const base = p.baseUrl.replace(/\/v1$/, "");
  const reply = await postJson(
    `${base}/v1/messages`,
    { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
    toAnthropicBody(model, payload),
    timeoutMs
  );
  if (!reply.res.ok) return fromErrorResponse(p, model, usedVision, reply);
  if (!reply.data || typeof reply.data !== "object") return failure(p, model, "bad_response", { status: reply.res.status });

  const text = (Array.isArray(reply.data.content) ? reply.data.content : [])
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  if (!text) return failure(p, model, reply.data.stop_reason === "refusal" ? "content_blocked" : "empty");
  return { ok: true, text };
}

async function callOpenAIStyle(p, model, usedVision, payload, timeoutMs) {
  const url = `${p.baseUrl}/chat/completions`;
  const headers = { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` };
  const body = toOpenAIBody(model, payload);

  let reply = await postJson(url, headers, body, timeoutMs);
  // Newer OpenAI models renamed max_tokens → max_completion_tokens. If that's the complaint, say it their way.
  if (!reply.res.ok && /max_completion_tokens/i.test(String(extractMessage(reply.data, reply.raw)))) {
    const { max_tokens, ...rest } = body;
    reply = await postJson(url, headers, { ...rest, max_completion_tokens: max_tokens }, timeoutMs);
  }

  if (!reply.res.ok) return fromErrorResponse(p, model, usedVision, reply);
  if (!reply.data || typeof reply.data !== "object") return failure(p, model, "bad_response", { status: reply.res.status });

  // Some gateways answer HTTP 200 with an error inside — treat that as the failure it is.
  if (!reply.data.choices && reply.data.error) {
    const embedded = Number(reply.data.error.code) || Number(reply.data.status) || 502;
    const { code, ctx } = classifyHttpError(embedded, reply.data, reply.raw, reply.res.headers);
    return failure(p, model, code, { ...ctx, usedVision });
  }

  const choice = (Array.isArray(reply.data.choices) ? reply.data.choices[0] : null) || {};
  let content = choice.message && choice.message.content;
  if (Array.isArray(content)) content = content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("");
  const text = typeof content === "string" ? stripReasoning(content) : "";
  if (!text) {
    const blocked = choice.finish_reason === "content_filter" || (choice.message && choice.message.refusal);
    return failure(p, model, blocked ? "content_blocked" : "empty", { detail: blocked && choice.message && choice.message.refusal ? tidy(choice.message.refusal) : "" });
  }
  return { ok: true, text };
}

async function attempt(p, payload, timeoutMs) {
  const usedVision = Boolean(payload.hasImages && p.visionModel);
  const model = usedVision ? p.visionModel : p.model;
  const started = Date.now();
  let result;
  try {
    result = p.style === "anthropic" ? await callAnthropic(p, model, usedVision, payload, timeoutMs) : await callOpenAIStyle(p, model, usedVision, payload, timeoutMs);
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) result = failure(p, model, "timeout", { afterMs: timeoutMs });
    else if (err instanceof TypeError || (err && err.cause)) result = failure(p, model, "upstream_unreachable", { reason: describeNetworkError(err) });
    else result = failure(p, model, "unknown", { detail: tidy(err && err.message) });
  }
  return { ...result, provider: p.label, model, ms: Date.now() - started };
}

// Tries each configured provider in order. A provider whose account is unusable (no credit, bad key,
// overloaded…) is skipped and the next one answers; a problem with the request itself stops right there.
async function runChain(providers, payload) {
  const budget = Number(readEnv("AI_TOTAL_TIMEOUT_MS")) || DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const left = () => budget - (Date.now() - startedAt);

  const attempts = [];
  const usable = providers.filter((p) => !p.problem);

  for (const p of providers) {
    if (p.problem) {
      attempts.push({ ok: false, code: "missing_config", provider: p.label, model: p.model, message: p.problem, brief: BRIEF.missing_config, status: 503, fallback: true });
      continue;
    }
    const isLastResort = p === usable[usable.length - 1];

    let result;
    for (let n = 0; n < 2; n++) {
      const cap = Math.max(500, isLastResort ? left() : Math.min(left(), FIRST_ATTEMPT_CAP_MS));
      result = await attempt(p, payload, cap);
      if (result.ok || !result.retryable || n === 1) break;
      const wait = Math.min(result.retryAfterMs || 700, 2500); // one polite retry, like the official SDKs do
      if (left() < wait + 4000) break;
      await sleep(wait);
    }

    if (result.ok) return { ok: true, ...result, skipped: attempts };
    console.error("[ai]", JSON.stringify({ provider: result.provider, model: result.model, code: result.code, upstreamStatus: result.upstreamStatus, message: result.message }));
    attempts.push(result);
    if (!result.fallback || left() < 3000) break;
  }
  return { ok: false, attempts };
}

const publicAttempt = (a) => ({ provider: a.provider, model: a.model || undefined, code: a.code, upstreamStatus: a.upstreamStatus, message: a.message });

function failurePayload(attempts) {
  if (attempts.length === 1) {
    const a = attempts[0];
    return { status: a.status || 502, body: { error: a.message, code: a.code, provider: a.provider, model: a.model || undefined, upstreamStatus: a.upstreamStatus, attempts: [publicAttempt(a)] } };
  }
  const summary = attempts.map((a) => `${a.provider}: ${a.brief || BRIEF.unknown}.`).join(" ");
  return { status: 502, body: { error: `None of the configured AI providers could answer. ${summary}`, code: "all_providers_failed", attempts: attempts.map(publicAttempt) } };
}

/* ───────────────────────────── the endpoint ───────────────────────────── */

const TEST_PAYLOAD = {
  system: "This is a connection check inside a customer-service tool. Reply with exactly: OK",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }],
  hasImages: false,
  maxTokens: 32,
};

function parseBody(body) {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  try {
    return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""));
  } catch {
    return {};
  }
}

function statusPayload(providers) {
  if (providers.length === 0) return { ok: false, version: VERSION, error: MISSING_KEY_MESSAGE, code: "missing_key", configured: [] };
  return {
    ok: providers.some((p) => !p.problem),
    version: VERSION,
    configured: providers.map((p) => ({ provider: p.label, model: p.model || null, imageModel: p.visionModel || undefined, key: p.keyVar, problem: p.problem || undefined })),
    next: "Add ?test=1 to this address to make one real call and see the exact result.",
  };
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const providers = buildProviders();

  if (req.method === "GET") {
    if (!url.searchParams.has("test")) return send(res, 200, statusPayload(providers), true);
    if (providers.length === 0) return send(res, 503, { ok: false, version: VERSION, error: MISSING_KEY_MESSAGE, code: "missing_key" }, true);
    const result = await runChain(providers, TEST_PAYLOAD);
    if (result.ok) return send(res, 200, { ok: true, version: VERSION, reply: result.text, provider: result.provider, model: result.model, ms: result.ms, skipped: result.skipped.map(publicAttempt) }, true);
    const failed = failurePayload(result.attempts);
    return send(res, failed.status, { ok: false, version: VERSION, ...failed.body }, true);
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Method not allowed — this endpoint takes POST.", code: "method_not_allowed" });
  }
  if (providers.length === 0) return send(res, 503, { error: MISSING_KEY_MESSAGE, code: "missing_key" });

  const body = parseBody(req.body);
  const normalized = normalizeMessages(body.messages);
  if (normalized.error) return send(res, 400, { error: normalized.error, code: "bad_request" });

  const result = await runChain(providers, {
    system: typeof body.system === "string" ? body.system : "",
    messages: normalized.messages,
    hasImages: normalized.hasImages,
    maxTokens: clampTokens(body.maxTokens),
  });

  if (result.ok) {
    const payload = { text: result.text, provider: result.provider, model: result.model, ms: result.ms };
    if (result.skipped.length) payload.skipped = result.skipped.map(publicAttempt);
    return send(res, 200, payload);
  }
  const failed = failurePayload(result.attempts);
  return send(res, failed.status, failed.body);
}

export default async function handler(req, res) {
  try {
    await route(req, res);
  } catch (err) {
    // A bug in this file must still reach the screen as a readable message, never a blank platform error page.
    console.error("[ai] unexpected", err && err.stack ? err.stack : err);
    if (!res.headersSent) send(res, 500, { error: `The AI function hit an unexpected error: ${tidy(err && err.message)}`, code: "internal_error" });
  }
}
