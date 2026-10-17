const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are",
  "was", "were", "i", "you", "my", "your", "it", "this", "that", "with",
  "have", "has", "not", "be", "as", "at", "from", "but", "if", "so", "we",
  "us", "our", "me", "he", "she", "they", "them", "will", "would", "can",
  "could", "do", "does", "did", "been", "being", "there", "what", "when",
  "where", "how", "just", "about",
]);

function tokenize(str) {
  const matches = (str || "").toLowerCase().match(/[a-z0-9']+/g);
  return (matches || []).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function scoreEntry(queryTokens, entry) {
  const entryTokens = tokenize(`${entry.title} ${entry.content}`);
  let score = 0;
  for (const t of entryTokens) {
    if (queryTokens.has(t)) score += 1;
  }
  return score;
}

// Every entry scored against the case, best first: [{ entry, score }].
export function matchKb(message, extraContext, kbEntries) {
  const queryTokens = new Set(tokenize(`${message} ${extraContext || ""}`));
  return kbEntries.map((entry) => ({ entry, score: scoreEntry(queryTokens, entry) })).sort((a, b) => b.score - a.score);
}

// What goes into the AI's prompt: everything if the KB is small, otherwise the best matches.
export function getRelevantKb(message, extraContext, kbEntries, topN = 10) {
  if (kbEntries.length <= topN) return kbEntries;
  return matchKb(message, extraContext, kbEntries)
    .slice(0, topN)
    .map((x) => x.entry);
}

export function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n).trim()}…` : str;
}

/* ───────────────────────── importing a knowledge base from a file ───────────────────────── */

export const KB_IMPORT_ACCEPT = ".txt,.md,.markdown,.csv,.json";
const MAX_IMPORT_BYTES = 500_000;
const MAX_ENTRIES = 300;
const MAX_ENTRY_CHARS = 4000;

const TITLE_KEYS = ["title", "question", "name", "topic", "heading", "subject", "q"];
const CONTENT_KEYS = ["content", "answer", "body", "policy", "text", "response", "description", "details", "a"];

function cleanEntry(title, content) {
  const t = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, 140);
  const c = String(content == null ? "" : content).replace(/\r\n/g, "\n").trim().slice(0, MAX_ENTRY_CHARS);
  if (!c) return null;
  return { title: t || truncate(c.split("\n")[0], 60) || "Untitled", content: c };
}

function pick(obj, keys) {
  const lower = {};
  for (const k of Object.keys(obj)) lower[k.toLowerCase().trim()] = obj[k];
  for (const key of keys) if (lower[key] != null && String(lower[key]).trim()) return lower[key];
  return "";
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("That file isn't valid JSON. Check for a missing comma or bracket.");
  }
  if (data && !Array.isArray(data) && Array.isArray(data.entries)) data = data.entries;
  if (Array.isArray(data)) {
    return data
      .map((row) => (row && typeof row === "object" ? cleanEntry(pick(row, TITLE_KEYS), pick(row, CONTENT_KEYS)) : typeof row === "string" ? cleanEntry("", row) : null))
      .filter(Boolean);
  }
  if (data && typeof data === "object") {
    return Object.entries(data)
      .map(([k, v]) => (typeof v === "string" ? cleanEntry(k, v) : null))
      .filter(Boolean);
  }
  return [];
}

// Small CSV reader: handles quoted cells, commas and line breaks inside quotes, and "" escapes.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const titleIdx = header.findIndex((h) => TITLE_KEYS.includes(h));
  const contentIdx = header.findIndex((h, i) => i !== titleIdx && CONTENT_KEYS.includes(h));
  const hasHeader = titleIdx !== -1 || contentIdx !== -1;
  const body = hasHeader ? rows.slice(1) : rows;
  const tIdx = hasHeader ? titleIdx : 0;
  const cIdx = hasHeader ? (contentIdx !== -1 ? contentIdx : titleIdx === 0 ? 1 : 0) : 1;
  return body.map((r) => cleanEntry(tIdx === -1 ? "" : r[tIdx], r[cIdx] != null ? r[cIdx] : r.length === 1 ? r[0] : "")).filter(Boolean);
}

function parseText(text, fileName) {
  const normalized = text.replace(/\r\n/g, "\n");
  // Markdown-style headings split the file into one entry per section.
  if (/^#{1,4}\s+\S/m.test(normalized)) {
    const sections = normalized.split(/^(?=#{1,4}\s+\S)/m);
    return sections
      .map((section) => {
        const lines = section.split("\n");
        const m = lines[0].match(/^#{1,4}\s+(.*)$/);
        return m ? cleanEntry(m[1], lines.slice(1).join("\n")) : cleanEntry("", section); // text before the first heading
      })
      .filter(Boolean);
  }
  // Otherwise: blank-line-separated blocks. A short first line with more lines under it is the title.
  const blocks = normalized.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) return [cleanEntry(fileName.replace(/\.[^.]+$/, ""), normalized)].filter(Boolean);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      const first = lines[0].trim();
      if (lines.length > 1 && first.length <= 80 && !/[.!?]$/.test(first)) return cleanEntry(first.replace(/:$/, ""), lines.slice(1).join("\n"));
      return cleanEntry("", block);
    })
    .filter(Boolean);
}

// → { entries: [{title, content}], skipped: number } or throws an Error with a plain message.
export function parseKbFile(fileName, text, fileSize = text.length) {
  if (fileSize > MAX_IMPORT_BYTES) throw new Error(`That file is too large (${Math.round(fileSize / 1000)} KB). Split it into files under ${MAX_IMPORT_BYTES / 1000} KB.`);
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  if (!["txt", "md", "markdown", "csv", "json"].includes(ext)) {
    throw new Error(`Can't read “.${ext}” files yet. Save it as .txt, .md, .csv or .json (for a Word or PDF document, copy the text into a .txt file).`);
  }
  if (!text.trim()) throw new Error("That file is empty.");

  let entries = ext === "json" ? parseJson(text) : ext === "csv" ? parseCsv(text) : parseText(text, fileName);
  if (entries.length === 0) throw new Error("I couldn't find any entries in that file. Use headings (# Title), a title/answer CSV, or a JSON list of {title, content}.");
  const skipped = Math.max(0, entries.length - MAX_ENTRIES);
  entries = entries.slice(0, MAX_ENTRIES);
  return { entries, skipped };
}
