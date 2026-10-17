import { useState, useRef, useEffect } from "react";
import { List } from "@phosphor-icons/react";
import { colors } from "./lib/colors.js";
import { loadJSON, saveJSON } from "./lib/storage.js";
import { getRelevantKb, matchKb } from "./lib/kb.js";
import { callClaudeDetailed, buildCaseSystemPrompt, buildOpeningUserMessage, parseOpening, buildUserContent, sendEmail, getEmailStatus, DRAFT_OPEN, DRAFT_CLOSE } from "./lib/api.js";
import { SEED_CASES } from "./lib/seedCases.js";
import Sidebar from "./components/Sidebar.jsx";
import GetStarted from "./components/GetStarted.jsx";
import CaseListView from "./components/CaseListView.jsx";
import HistoryView from "./components/HistoryView.jsx";
import KnowledgeBaseView from "./components/KnowledgeBaseView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import { Banner, QueueToast } from "./components/ui.jsx";

const KB_KEY = "resolve-kb-entries";
const CASES_KEY = "resolve-cases";
const SEED_INDEX_KEY = "resolve-seed-index";
const CHAT_WIDTH_KEY = "resolve-chat-width";
const AUTO_NEXT_KEY = "resolve-auto-next";
const SEARCH_MS_KEY = "resolve-search-ms"; // normally unset; lets tests and demos shorten the wait
const SEARCH_MS = 5000; // how long "looking for the next case" takes, like a live queue
const MIN_CHAT_WIDTH = 320;
const MAX_CHAT_WIDTH = 560;
const MAX_MESSAGES_SENT = 24; // keeps a very long chat inside the model's context window
const PROMPT_ENTRY_CHARS = 2000; // one huge knowledge-base entry can't crowd out the rest

const newId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeCase({ message, context = "", customerEmail = "", customerPhone = "", details = {}, attachments = [] }) {
  return {
    id: newId("case"),
    message,
    context,
    customerEmail,
    customerPhone,
    details,
    attachments,
    category: null,
    urgency: null,
    sentiment: null,
    status: "New",
    chat: [],
    createdAt: new Date().toISOString(),
  };
}

// The hidden first message is stored as plain text; the customer's pictures live on the case itself.
// Put them back in when talking to the AI so it can still see them on every later turn.
function chatForApi(item) {
  const attachments = item.attachments || [];
  const chat = item.chat.map((m, i) => (i === 0 && m.hidden && attachments.length ? { ...m, content: buildUserContent(typeof m.content === "string" ? m.content : "", attachments) } : m));
  const trimmed = chat.length > MAX_MESSAGES_SENT ? [chat[0], ...chat.slice(-(MAX_MESSAGES_SENT - 1))] : chat;
  return trimmed.map((m) => ({ role: m.role, content: m.content }));
}

// Models follow an instruction in the newest message far more reliably than one in the system prompt, so each
// new advisor message carries a short reminder about fencing the customer-ready text. It's only sent to the AI —
// the advisor never sees it in the chat.
const DRAFT_REMINDER = `\n\n(Reminder: if your reply includes text meant for the customer, put only that text between ${DRAFT_OPEN} and ${DRAFT_CLOSE}.)`;
function withDraftReminder(content) {
  if (typeof content === "string") return content + DRAFT_REMINDER;
  if (Array.isArray(content)) {
    const i = content.findIndex((b) => b.type === "text");
    if (i === -1) return [...content, { type: "text", text: DRAFT_REMINDER.trim() }];
    return content.map((b, j) => (j === i ? { ...b, text: b.text + DRAFT_REMINDER } : b));
  }
  return content;
}

function promptKb(entries) {
  return entries.map((e) => ({ ...e, content: String(e.content || "").slice(0, PROMPT_ENTRY_CHARS) }));
}

function matchedTitles(item, kb) {
  return matchKb(item.message, item.context, kb)
    .filter((x) => x.score > 0)
    .slice(0, 3)
    .map((x) => x.entry.title);
}

export default function App() {
  const [view, setView] = useState("getstarted");
  const [statusFilter, setStatusFilter] = useState(null);
  const [kb, setKb] = useState(() => loadJSON(KB_KEY, []));
  const [cases, setCases] = useState(() => loadJSON(CASES_KEY, []));
  const [selectedCaseId, setSelectedCaseId] = useState(null);
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(() => loadJSON(CHAT_WIDTH_KEY, 400));
  const [emailConfigured, setEmailConfigured] = useState(false);
  const [storageFailed, setStorageFailed] = useState({});
  const [autoNext, setAutoNext] = useState(() => loadJSON(AUTO_NEXT_KEY, true) !== false);
  const [searching, setSearching] = useState(null); // null | "manual" | "auto"
  const searchTimer = useRef(null);
  const autoNextRef = useRef(autoNext);
  autoNextRef.current = autoNext;
  const resizingRef = useRef(false);
  const seedRef = useRef(Number(loadJSON(SEED_INDEX_KEY, 0)) || 0);

  // Async handlers read the latest data from these, so a reply that lands late never works from a stale copy.
  const casesRef = useRef(cases);
  casesRef.current = cases;
  const kbRef = useRef(kb);
  kbRef.current = kb;

  // Everything is saved by watching the state itself, so no code path can forget to save.
  useEffect(() => {
    const ok = saveJSON(CASES_KEY, cases);
    setStorageFailed((f) => (f.cases === !ok ? f : { ...f, cases: !ok }));
  }, [cases]);
  useEffect(() => {
    const ok = saveJSON(KB_KEY, kb);
    setStorageFailed((f) => (f.kb === !ok ? f : { ...f, kb: !ok }));
  }, [kb]);

  useEffect(() => {
    let alive = true;
    getEmailStatus().then((s) => alive && setEmailConfigured(s.configured));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => clearTimeout(searchTimer.current), []);

  useEffect(() => {
    function onMouseMove(e) {
      if (!resizingRef.current) return;
      const fromRight = window.innerWidth - e.clientX;
      setChatWidth(Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, fromRight)));
    }
    function onMouseUp() {
      if (!resizingRef.current) return;
      resizingRef.current = false;
      document.body.style.cursor = "";
      setChatWidth((w) => {
        saveJSON(CHAT_WIDTH_KEY, w);
        return w;
      });
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const resizeHandleProps = {
    onMouseDown: () => {
      resizingRef.current = true;
      document.body.style.cursor = "col-resize";
    },
  };

  const updateKb = (newKb) => setKb(newKb);

  // Change one case without touching the others — safe even when two replies arrive at nearly the same time.
  function patchCase(id, patch) {
    setCases((prev) => prev.map((c) => (c.id === id ? { ...c, ...(typeof patch === "function" ? patch(c) : patch) } : c)));
  }

  // The "alive" flow: cases come from a queue instead of the advisor typing them in. Looking takes a few
  // seconds, like a live queue. Swap pullNextCase for a real inbox/form later without touching anything
  // downstream — everything else just reads from `cases`.
  function pullNextCase() {
    const seed = SEED_CASES[seedRef.current % SEED_CASES.length];
    seedRef.current += 1;
    saveJSON(SEED_INDEX_KEY, seedRef.current);

    const newCase = makeCase({ message: seed.message, context: seed.context, customerEmail: seed.customerEmail || "", details: seed.details || {} });
    setCases((prev) => [newCase, ...prev]);
    setSelectedCaseId(newCase.id);
    setView("cases");
    setStatusFilter(null);
  }

  function startSearch(source) {
    if (searchTimer.current) return; // already looking
    setSearching(source);
    const configured = Number(loadJSON(SEARCH_MS_KEY, SEARCH_MS));
    const wait = Number.isFinite(configured) && configured >= 0 ? configured : SEARCH_MS;
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      setSearching(null);
      pullNextCase();
    }, wait);
  }

  function cancelSearch() {
    clearTimeout(searchTimer.current);
    searchTimer.current = null;
    setSearching(null);
  }

  const handleGetNextCase = () => startSearch("manual");

  function handleAutoNextChange(on) {
    setAutoNext(on);
    saveJSON(AUTO_NEXT_KEY, on);
    if (!on && searching === "auto") cancelSearch();
  }

  async function handleCreateCase(message, context, details = {}, attachments = []) {
    const newCase = makeCase({ message, context, details, attachments });
    setCases((prev) => [newCase, ...prev]);
    setSelectedCaseId(newCase.id);
  }

  async function handleSendMessage(caseId, userText, images) {
    const current = casesRef.current.find((c) => c.id === caseId);
    if (!current) return;

    const kbNow = kbRef.current;
    const system = buildCaseSystemPrompt(current.message, current.context, promptKb(getRelevantKb(current.message, current.context, kbNow, 10)), current.details, (current.attachments || []).length);
    const userMessage = { role: "user", content: buildUserContent(userText, images) };

    const { text } = await callClaudeDetailed({ system, messages: [...chatForApi(current), { role: "user", content: withDraftReminder(userMessage.content) }], maxTokens: 1000 });

    const used = matchedTitles(current, kbNow);
    patchCase(caseId, (c) => ({ chat: [...c.chat, userMessage, { role: "assistant", content: text, ...(used.length ? { kb: used } : {}) }] }));
  }

  // Also used to auto-prepare a freshly pulled case with an empty chat —
  // ChatPanel calls this itself the moment such a case is selected.
  async function handleRefreshCase(caseId) {
    const current = casesRef.current.find((c) => c.id === caseId);
    if (!current) return;

    const kbNow = kbRef.current;
    const attachments = current.attachments || [];
    const system = buildCaseSystemPrompt(current.message, current.context, promptKb(getRelevantKb(current.message, current.context, kbNow, 10)), current.details, attachments.length);
    const openingText = buildOpeningUserMessage();

    const { text } = await callClaudeDetailed({ system, messages: [{ role: "user", content: buildUserContent(openingText, attachments) }], maxTokens: 1000 });
    const parsed = parseOpening(text);
    const used = matchedTitles(current, kbNow);

    patchCase(caseId, {
      category: parsed.category,
      urgency: parsed.urgency,
      sentiment: parsed.sentiment,
      chat: [
        { role: "user", content: openingText, hidden: true },
        { role: "assistant", content: parsed.message, ...(used.length ? { kb: used } : {}) },
      ],
    });
  }

  async function handleSendEmail(caseId, { to, subject, body }) {
    await sendEmail({ to, subject, body });
  }

  function handleUpdateContact(caseId, contact) {
    patchCase(caseId, contact);
  }

  function handleChangeStatus(caseId, newStatus) {
    const before = casesRef.current.find((c) => c.id === caseId);
    patchCase(caseId, { status: newStatus });
    // Finishing a new case (sent it on, transferred it, closed it) starts the hunt for the next one.
    if (autoNextRef.current && before && before.status === "New" && newStatus !== "New") startSearch("auto");
  }

  function handleResetAll() {
    cancelSearch();
    setKb([]);
    setCases([]);
    setSelectedCaseId(null);
    setView("getstarted");
    setStatusFilter(null);
  }

  function handleNavigate(key) {
    setView(key);
    setSelectedCaseId(null);
  }

  function handleSelectStatus(status) {
    setView("cases");
    setStatusFilter(status);
    setSelectedCaseId(null);
  }

  const selectedCase = selectedCaseId ? cases.find((c) => c.id === selectedCaseId) : null;
  const counts = {
    all: cases.length,
    New: cases.filter((c) => c.status === "New").length,
    Transferred: cases.filter((c) => c.status === "Transferred").length,
    Closed: cases.filter((c) => c.status === "Closed").length,
    "Waiting for Customer": cases.filter((c) => c.status === "Waiting for Customer").length,
  };
  const storageFull = Boolean(storageFailed.cases || storageFailed.kb);

  return (
    <div className="rsv-screen flex w-full overflow-hidden font-sans" style={{ backgroundColor: colors.white }}>
      <style>{`
        :root { --chat-width: ${chatWidth}px; }
        .rsv-screen { height: 100vh; height: 100dvh; }
        .rsv-input {
          background: #F5F5F5;
          border: 1px solid #F5F5F5;
          color: #171717;
          transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
        }
        .rsv-input::placeholder { color: #B8B8B8; }
        .rsv-input:focus, .rsv-input:focus-within {
          outline: none;
          border-color: #171717;
          box-shadow: 0 0 0 3px rgba(23,23,23,0.08);
          background: #fff;
        }
        .rsv-btn-primary {
          background: #000000;
          color: #ffffff;
          transition: opacity 0.15s ease, transform 0.1s ease;
        }
        .rsv-btn-primary:hover:not(:disabled) { opacity: 0.85; }
        .rsv-btn-primary:active:not(:disabled) { transform: scale(0.98); }
        .rsv-btn-ghost {
          background: transparent;
          color: #171717;
          border: 1px solid #F5F5F5;
          transition: background 0.15s ease;
        }
        .rsv-btn-ghost:hover:not(:disabled) { background: #F0F0F0; }
        .rsv-icon-btn { transition: background 0.15s ease; }
        .rsv-icon-btn:hover { background: #F0F0F0; }
        .rsv-history-item { transition: border-color 0.15s ease; }
        .rsv-history-item:hover { border-color: #B8B8B8 !important; }
        .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .line-clamp-4 { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
        .rsv-chat-panel { width: var(--chat-width); }
        /* On a short screen the conversation matters more than the tip banner. */
        @media (max-height: 700px) {
          .rsv-hint { display: none; }
        }
        @media (max-width: 767px) {
          .rsv-chat-panel { width: 100% !important; }
        }
        @keyframes rsv-dot { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
        .rsv-dot { display: inline-block; width: 5px; height: 5px; border-radius: 9999px; background: #B8B8B8; animation: rsv-dot 1.2s infinite ease-in-out; }
        .rsv-dot:nth-child(2) { animation-delay: .15s; }
        .rsv-dot:nth-child(3) { animation-delay: .3s; }
      `}</style>

      {searching && <QueueToast source={searching} onCancel={cancelSearch} />}

      <Sidebar
        view={view}
        statusFilter={statusFilter}
        onNavigate={handleNavigate}
        onSelectStatus={handleSelectStatus}
        counts={counts}
        mobileOpen={sidebarMobileOpen}
        onCloseMobile={() => setSidebarMobileOpen(false)}
      />

      {/* Middle: list-type views */}
      <div
        className={`${selectedCaseId ? "hidden" : "flex"} md:flex flex-col w-full md:flex-1 md:min-w-0 overflow-y-auto rsv-screen`}
        style={{ borderRight: `1px solid ${colors.border}`, backgroundColor: colors.white }}
      >
        <div className="md:hidden flex items-center gap-3 px-4 py-4 shrink-0" style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.white }}>
          <button onClick={() => setSidebarMobileOpen(true)} className="p-1 rounded-full rsv-icon-btn" style={{ color: colors.gray }} aria-label="Open menu">
            <List className="w-5 h-5" />
          </button>
          <h1 className="text-base font-medium" style={{ color: colors.black }}>Resolve</h1>
        </div>
        <div className="p-4 md:p-[59px] flex-1">
          {storageFull && (
            <Banner
              kind="warning"
              className="mb-4"
              testId="storage-full"
              message="This browser's storage is full, so your latest changes aren't being saved. Remove large attachments or old cases (Settings → Reset all data) to make room."
            />
          )}
          {view === "getstarted" && <GetStarted onStart={handleGetNextCase} searching={Boolean(searching)} cases={cases} onSelectCase={(id) => { setView("cases"); setSelectedCaseId(id); }} onSeeHistory={() => handleNavigate("history")} />}
          {view === "cases" && (
            <CaseListView
              cases={cases}
              statusFilter={statusFilter}
              selectedCaseId={selectedCaseId}
              onSelectCase={setSelectedCaseId}
              onGetNextCase={handleGetNextCase}
              searching={Boolean(searching)}
              onCreateCase={handleCreateCase}
              kbCount={kb.length}
              onGoToKb={() => handleNavigate("kb")}
            />
          )}
          {view === "history" && <HistoryView cases={cases} selectedCaseId={selectedCaseId} onSelectCase={setSelectedCaseId} />}
          {view === "kb" && <KnowledgeBaseView kb={kb} onUpdateKb={updateKb} />}
          {view === "settings" && <SettingsView onResetAll={handleResetAll} autoNext={autoNext} onAutoNextChange={handleAutoNextChange} />}
        </div>
      </div>

      {/* Right: AI Assistant — full screen on phones, resizable side panel on desktop */}
      <div className={`${selectedCaseId ? "flex" : "hidden"} md:flex md:shrink-0 w-full md:w-auto`}>
        <ChatPanel
          item={selectedCase}
          onSendMessage={handleSendMessage}
          onChangeStatus={handleChangeStatus}
          onRefresh={handleRefreshCase}
          onNewCase={handleGetNextCase}
          searching={Boolean(searching)}
          onSendEmail={handleSendEmail}
          onUpdateContact={handleUpdateContact}
          onBack={() => setSelectedCaseId(null)}
          onOpenSettings={() => handleNavigate("settings")}
          emailConfigured={emailConfigured}
          resizeHandleProps={resizeHandleProps}
        />
      </div>
    </div>
  );
}
