// Plain-Node checks for the pure parts of src/lib/api.js: splitting the AI note from the customer-ready draft,
// and reading the assistant's first answer even when it isn't clean JSON.  Run with: npm test
import assert from "node:assert/strict";
import { splitDraft, composeAssistantMessage, parseOpening, DRAFT_OPEN, DRAFT_CLOSE, buildCaseSystemPrompt, buildOpeningUserMessage } from "../src/lib/api.js";

let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log("PASS ", name); } catch (e) { console.log("FAIL ", name, "—", e.message.split("\n")[0]); process.exitCode = 1; } };

t("splitDraft: note + fenced draft + trailing remark", () => {
  const r = splitDraft(`I used the refund policy.\n\n${DRAFT_OPEN}\nHi Sam,\n\nYour refund is on its way.\n\nBest,\nBless\n${DRAFT_CLOSE}\n\nWant it shorter?`);
  assert.equal(r.hasDraft, true);
  assert.equal(r.draft, "Hi Sam,\n\nYour refund is on its way.\n\nBest,\nBless");
  assert.equal(r.note, "I used the refund policy.\n\nWant it shorter?");
});
t("splitDraft: no markers → everything is the note, no draft", () => {
  const r = splitDraft("The refund policy allows 30 days.");
  assert.deepEqual(r, { note: "The refund policy allows 30 days.", draft: "", hasDraft: false });
});
t("splitDraft: forgiving brackets and a missing closing line", () => {
  assert.equal(splitDraft("[[DRAFT]]\nHi there\n[[END DRAFT]]").draft, "Hi there");
  assert.equal(splitDraft("<<DRAFT>>\nHi there, no closing line").draft, "Hi there, no closing line");
  assert.equal(splitDraft("<<<draft>>>\nlower case works\n<<<end draft>>>").draft, "lower case works");
});
t("splitDraft: empty draft block counts as no draft; null/undefined are safe", () => {
  assert.equal(splitDraft(`${DRAFT_OPEN}\n\n${DRAFT_CLOSE}`).hasDraft, false);
  assert.equal(splitDraft(null).note, "");
  assert.equal(splitDraft(undefined).hasDraft, false);
});
t("compose + split round-trip; empty summary leaves just the draft", () => {
  const m = composeAssistantMessage("Short note.", "Hi Kofi,\n\nThanks.\n\nBless");
  const r = splitDraft(m);
  assert.equal(r.note, "Short note."); assert.equal(r.draft, "Hi Kofi,\n\nThanks.\n\nBless");
  const only = splitDraft(composeAssistantMessage("", "Hello"));
  assert.equal(only.note, ""); assert.equal(only.draft, "Hello");
});
t("parseOpening: clean JSON with summary + reply", () => {
  const o = parseOpening(JSON.stringify({ category: "Refund", urgency: "High", sentiment: "Angry", summary: "Wants money back.", reply: "Hi Ama,\n\nSorry.\n\nBless" }));
  assert.equal(o.category, "Refund"); assert.equal(o.urgency, "High"); assert.equal(o.sentiment, "Angry");
  const s = splitDraft(o.message);
  assert.equal(s.note, "Wants money back."); assert.equal(s.draft, "Hi Ama,\n\nSorry.\n\nBless");
});
t("parseOpening: code fence + raw line breaks inside the strings (not valid JSON)", () => {
  const raw = '```json\n{"category": "Delivery delay", "urgency": "High", "sentiment": "Angry", "summary": "Parcel is late.", "reply": "Hi Jordan,\n\nSorry about the wait.\n\nBless"}\n```';
  const o = parseOpening(raw);
  assert.equal(o.category, "Delivery delay"); assert.equal(o.urgency, "High");
  const s = splitDraft(o.message);
  assert.equal(s.note, "Parcel is late."); assert.equal(s.draft, "Hi Jordan,\n\nSorry about the wait.\n\nBless");
});
t("parseOpening: reply listed before summary, raw line breaks", () => {
  const raw = '{"reply": "Hi Jo,\n\nThanks for waiting.\n\nBless", "summary": "Late parcel.", "category": "Delivery", "urgency": "Low", "sentiment": "Neutral"}';
  const s = splitDraft(parseOpening(raw).message);
  assert.equal(s.draft, "Hi Jo,\n\nThanks for waiting.\n\nBless"); assert.equal(s.note, "Late parcel.");
});
t("parseOpening: older single 'message' shape still works (kept whole)", () => {
  const o = parseOpening('{"category":"Billing","urgency":"Medium","sentiment":"Neutral","message":"Note.\\n\\nHi Ama,\\nDone."}');
  assert.equal(o.category, "Billing"); assert.equal(o.message, "Note.\n\nHi Ama,\nDone.");
});
t("parseOpening: older 'message' shape with raw line breaks", () => {
  const o = parseOpening('{"category": "X", "urgency": "Low", "sentiment": "Neutral", "message": "Hi,\n\nBye"}');
  assert.equal(o.message, "Hi,\n\nBye");
});
t("parseOpening: plain prose (no JSON at all) is shown as it came", () => {
  const o = parseOpening("Sorry, I can't produce JSON but here is a reply: Hi Sam, thanks.");
  assert.equal(o.category, "General inquiry"); assert.match(o.message, /Hi Sam, thanks\./);
});
t("parseOpening: unknown urgency/sentiment fall back to safe defaults", () => {
  const o = parseOpening('{"category":"A","urgency":"Extreme","sentiment":"Sad","reply":"Hi"}');
  assert.equal(o.urgency, "Medium"); assert.equal(o.sentiment, "Neutral");
});
t("prompts mention the draft lines and the new JSON keys", () => {
  const sys = buildCaseSystemPrompt("msg", "", [], {}, 0);
  assert.ok(sys.includes(DRAFT_OPEN) && sys.includes(DRAFT_CLOSE));
  const op = buildOpeningUserMessage();
  assert.ok(/"summary"/.test(op) && /"reply"/.test(op));
});
console.log(`\n${n} unit checks passed`);
