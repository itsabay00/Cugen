// Talking to the AI function (api/claude.js) and turning every way it can go wrong into a plain,
// specific sentence. The function itself reports provider problems (no credit, bad key, rate limit…);
// everything in this file is about the part before and around it — offline, timeouts, the function
// not being deployed, the host blocking the request, a photo that's too big, a crashed function.

const CLIENT_TIMEOUT_MS = 65_000; // a little longer than the server's own 60-second limit
const STATUS_TIMEOUT_MS = 15_000;

function makeError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const looksLikeHtml = (raw) => /^\s*<(!doctype|html|head|body)/i.test(raw || "");
const tidy = (text, max = 140) => String(text || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// One place for the fetch + timeout + "what came back" bookkeeping.
async function request(url, init = {}, timeoutMs = CLIENT_TIMEOUT_MS) {
  if (isOffline()) throw makeError("You're offline. Reconnect to the internet and try again.", "offline");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let raw = "";
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    raw = await response.text(); // read inside the timer so a stalled reply also times out
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw makeError(`Gave up after ${Math.round(timeoutMs / 1000)} seconds — the AI didn't answer in time. Try again.`, "timeout");
    }
    if (isOffline()) throw makeError("You're offline. Reconnect to the internet and try again.", "offline");
    throw makeError("Couldn't reach the Resolve server. Check your internet connection — if that's fine, the site itself may be down.", "network");
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  return { response, data, raw };
}

// The host (Vercel) answered, but not with our JSON — work out why from the status and the page it sent.
function explainPlatformFailure(status, raw) {
  const html = looksLikeHtml(raw);
  const platformCode = (String(raw || "").match(/\b([A-Z]{3,}(?:_[A-Z]{2,})+)\b/) || [])[1];
  const tail = platformCode ? ` (host code: ${platformCode})` : "";

  if (status === 404) {
    return makeError(
      `The AI function wasn't found at /api/claude (HTTP 404). On Vercel, check that the "api" folder is in your GitHub repo and redeploy. Running locally? Start the app with "vercel dev" — "npm run dev" doesn't include the api folder.${tail}`,
      "function_missing",
      { status }
    );
  }
  if ((status === 401 || status === 403) && (html || platformCode)) {
    return makeError(
      `Vercel blocked the request (HTTP ${status}) before it reached the AI — Deployment Protection is probably switched on. In Vercel → your project → Settings → Deployment Protection, turn off Vercel Authentication for Production, then try again.${tail}`,
      "blocked_by_host",
      { status }
    );
  }
  if (status === 413) {
    return makeError(`That request was too big for the server (HTTP 413) — usually a large photo. Remove the image or attach a smaller one.${tail}`, "request_too_large", { status });
  }
  if (status === 429) {
    return makeError("The server is receiving too many requests (HTTP 429). Wait a few seconds and try again.", "rate_limited", { status });
  }
  if (status === 504 || status === 408) {
    return makeError(`The server gave up waiting for the AI (HTTP ${status}). Try again — if it keeps happening, the AI provider is very slow right now.${tail}`, "timeout", { status });
  }
  if (status >= 500) {
    return makeError(
      `The server crashed before the AI could answer (HTTP ${status}). Try again; if it keeps happening, open Vercel → your project → Logs to see why.${tail}`,
      "server_error",
      { status }
    );
  }
  return makeError(`The server answered with something unexpected (HTTP ${status})${raw ? `: “${tidy(raw)}”` : ""}.`, "unknown", { status });
}

// HTTP 200, but not JSON — what a dev server does for a path it doesn't know (it sends back the web page).
function explainNotJson(raw) {
  if (looksLikeHtml(raw)) {
    return makeError(
      'The server sent back a web page instead of the AI function. Running locally? Start the app with "vercel dev" — "npm run dev" doesn\'t include the api folder. On Vercel, check that the "api" folder is in your repo and redeploy.',
      "function_missing"
    );
  }
  return makeError(`The AI function answered with something that isn't valid JSON${raw ? `: “${tidy(raw)}”` : ""}.`, "bad_response");
}

// Full detail: { text, provider, model, ms, skipped? }. Throws an Error with .code (and .provider/.model/.attempts when known).
export async function callClaudeDetailed({ system, messages, maxTokens }) {
  const { response, data, raw } = await request("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, maxTokens: maxTokens || 1000 }),
  });

  if (!response.ok) {
    if (data && typeof data.error === "string" && data.error) {
      throw makeError(data.error, data.code || "unknown", { provider: data.provider, model: data.model, status: response.status, attempts: data.attempts });
    }
    throw explainPlatformFailure(response.status, raw);
  }
  if (!data || typeof data !== "object") throw explainNotJson(raw);
  if (!data.text) throw makeError("The AI answered with an empty message. Try again.", "empty", { provider: data.provider, model: data.model });
  return data;
}

export async function callClaude(args) {
  return (await callClaudeDetailed(args)).text;
}

// Which providers the server has keys for (never includes the keys). Resolves even when none are set —
// the answer is then { ok:false, code:"missing_key", error }. Throws only when the function can't be reached.
export async function getAiStatus() {
  const { response, data, raw } = await request("/api/claude", { method: "GET" }, STATUS_TIMEOUT_MS);
  if (data && typeof data === "object" && ("configured" in data || "code" in data)) return data;
  if (!response.ok) throw explainPlatformFailure(response.status, raw);
  throw explainNotJson(raw);
}

// Makes one tiny real call through the same code path the assistant uses.
// Resolves with { ok:true, reply, provider, model, ms, skipped } or { ok:false, error, code, provider, attempts }.
export async function testAiConnection() {
  const { response, data, raw } = await request("/api/claude?test=1", { method: "GET" });
  if (data && typeof data === "object" && typeof data.ok === "boolean") return data;
  if (!response.ok) throw explainPlatformFailure(response.status, raw);
  throw explainNotJson(raw);
}

// Whether the optional direct-email sender is set up on the server. Never throws — "unknown" counts as "not set up".
export async function getEmailStatus() {
  try {
    const { data } = await request("/api/send-email", { method: "GET" }, STATUS_TIMEOUT_MS);
    return { configured: Boolean(data && data.configured) };
  } catch {
    return { configured: false };
  }
}

export async function sendEmail({ to, subject, body }) {
  const { response, data, raw } = await request("/api/send-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, body }),
  });
  if (!response.ok) {
    if (data && typeof data.error === "string" && data.error) throw makeError(data.error, data.code || "unknown", { status: response.status });
    throw explainPlatformFailure(response.status, raw);
  }
  return data || {};
}

/* ───────────────────────── prompts ───────────────────────── */

export function describeDetails(details) {
  const d = details || {};
  const rows = [];
  if (d.orderNumber) rows.push(`Order number: ${d.orderNumber}`);
  if (d.sku) rows.push(`Item / SKU: ${d.sku}`);
  if (d.trackingNumber) rows.push(`Tracking number: ${d.trackingNumber}`);
  if (d.trackingLink) rows.push(`Tracking link: ${d.trackingLink} (you can't open links — ask the advisor for what it shows if it matters)`);
  return rows;
}

// The AI's messages can hold two things: a note for the advisor and the customer-ready draft. The draft is
// fenced with these lines so the app can offer exactly that text to Copy / Send — never the advisor-only note.
export const DRAFT_OPEN = "<<<DRAFT>>>";
export const DRAFT_CLOSE = "<<<END DRAFT>>>";
// Forgiving on purpose: models sometimes write <<DRAFT>>, [[DRAFT]], or forget the closing line.
const DRAFT_RE = /(?:<{2,4}|\[{2,4})\s*DRAFT\s*(?:>{2,4}|\]{2,4})([\s\S]*?)(?:(?:<{2,4}|\[{2,4})\s*END[\s_-]*DRAFT\s*(?:>{2,4}|\]{2,4})|$)/i;

// → { note, draft, hasDraft }. Without the lines, the whole text counts as the note.
export function splitDraft(text) {
  const t = String(text || "");
  const m = t.match(DRAFT_RE);
  if (!m || !m[1].trim()) return { note: t.trim(), draft: "", hasDraft: false };
  const before = t.slice(0, m.index).trim();
  const after = t.slice(m.index + m[0].length).trim();
  return { note: [before, after].filter(Boolean).join("\n\n"), draft: m[1].trim(), hasDraft: true };
}

export function composeAssistantMessage(summary, reply) {
  const block = `${DRAFT_OPEN}\n${reply.trim()}\n${DRAFT_CLOSE}`;
  return summary && summary.trim() ? `${summary.trim()}\n\n${block}` : block;
}

export function buildCaseSystemPrompt(message, extraContext, relevantKb, details, imageCount = 0) {
  const kbBlock = relevantKb.length
    ? relevantKb.map((e) => `Title: ${e.title}\nAnswer: ${e.content}`).join("\n\n---\n\n")
    : "(the advisor hasn't added any knowledge-base entries yet)";
  const detailRows = describeDetails(details);
  const detailBlock = detailRows.length ? detailRows.join("\n") : "(none provided)";
  const imageNote = imageCount > 0 ? `\nThe customer attached ${imageCount} image${imageCount === 1 ? "" : "s"} — they're in the advisor's first message below.` : "";

  return `You are the AI Assistant inside "Resolve," a customer support tool. You're helping an advisor work one specific case, in an ongoing chat. Give context, review what you draft, and the advisor sends the final version to the customer themselves — you never send anything directly.

The case:
Customer's message: ${message}
Extra context from the advisor: ${extraContext && extraContext.trim() ? extraContext : "(none provided)"}
Details the customer gave:
${detailBlock}${imageNote}

Knowledge-base entries that may be relevant:
${kbBlock}

Ground any reply you draft in these knowledge-base entries when relevant. Never invent policies, refund amounts, timelines, or commitments the knowledge base or the customer's message doesn't support — say so plainly if nothing applies. When asked to draft or redraft a reply, write a complete, ready-to-send reply in a warm, professional customer-service voice.

Formatting rule for any reply meant for the customer: put ONLY the customer-ready text on its own between the lines ${DRAFT_OPEN} and ${DRAFT_CLOSE}. Anything you want to tell the advisor (what you changed, which policy you used) goes outside those lines, before or after. The advisor's Copy and Send buttons use only the text between the lines, so it must read as the final message: a greeting, the body, a sign-off, no notes to the advisor and no [placeholders]. When you're just answering a question and not drafting, don't use the lines.

When asked a question, answer it directly and concisely. This is a working tool inside a live chat, not a companion — keep responses focused and useful, not chatty.`;
}

// `images` may be one image, a list of them, or nothing.
export function buildUserContent(text, images) {
  const list = (Array.isArray(images) ? images : images ? [images] : []).filter(Boolean);
  if (list.length === 0) return text;
  // Neutral shape — api/claude.js translates this into whichever provider's own image format is
  // needed, so the frontend doesn't need to know which provider is configured.
  return [{ type: "text", text: text || "(see attached image)" }, ...list.map((image) => ({ type: "image", mediaType: image.mediaType, data: image.data }))];
}

export function buildOpeningUserMessage() {
  return `A new case just came in. Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{"category": "a short 2-4 word issue category", "urgency": "Low, Medium, or High", "sentiment": "Positive, Neutral, Frustrated, or Angry", "summary": "1-2 sentences for the advisor: what happened, what the customer wants, and which knowledge-base entry applies (if any)", "reply": "the complete customer-ready reply, warm and professional, roughly 80-160 words, written to be sent as-is: a greeting, the body, a sign-off — no notes to the advisor and no [placeholders]"}`;
}

const unescapeJsonString = (s) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

function shapeOpening(obj, fallbackText) {
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const reply = str(obj.reply);
  const summary = str(obj.summary);
  // `message` is the older single-string shape: it may already mix a note and a draft, so it is kept as it is.
  const message = reply ? composeAssistantMessage(summary, reply) : str(obj.message) || fallbackText;
  return {
    category: str(obj.category) || "General inquiry",
    urgency: ["Low", "Medium", "High"].includes(obj.urgency) ? obj.urgency : "Medium",
    sentiment: ["Positive", "Neutral", "Frustrated", "Angry"].includes(obj.sentiment) ? obj.sentiment : "Neutral",
    message,
  };
}

// Reads the assistant's first answer. Models don't always return clean JSON (code fences, stray text,
// raw line breaks inside the reply), so this tries the strict way first and then picks the fields out by hand.
export function parseOpening(raw) {
  const text = (raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const jsonStr = start !== -1 && end !== -1 && end > start ? text.slice(start, end + 1) : text;
  try {
    return shapeOpening(JSON.parse(jsonStr), text);
  } catch (err) {
    // fall through to the forgiving reader
  }

  const grab = (key) => {
    const m = jsonStr.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? unescapeJsonString(m[1]) : undefined;
  };
  // long text fields may contain raw line breaks and stray quotes, so read up to the next field (or the end)
  const grabLoose = (key) => {
    const m = jsonStr.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"(?:category|urgency|sentiment|summary|reply|message)"\\s*:|\\}?\\s*$)`));
    return m ? unescapeJsonString(m[1]) : undefined;
  };
  const reply = grabLoose("reply");
  const message = reply ? undefined : grabLoose("message");
  if ((reply && reply.trim()) || (message && message.trim())) {
    return shapeOpening({ category: grab("category"), urgency: grab("urgency"), sentiment: grab("sentiment"), summary: grabLoose("summary"), reply, message }, text);
  }

  return { category: "General inquiry", urgency: "Medium", sentiment: "Neutral", message: text };
}
