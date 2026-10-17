import { useState, useRef, useEffect } from "react";
import {
  ArrowLeft,
  ArrowClockwise,
  Plus,
  At,
  Paperclip,
  ArrowUp,
  Info,
  ChatsCircle,
  Copy,
  Check,
  X,
  EnvelopeSimple,
  WhatsappLogo,
  ChatText,
  CircleNotch,
} from "@phosphor-icons/react";
import { colors, semantic } from "../lib/colors.js";
import { loadJSON, saveJSON } from "../lib/storage.js";
import { prepareImage } from "../lib/image.js";
import { buildUserContent, splitDraft } from "../lib/api.js";
import { OutlinePill, GhostButton, PrimaryButton, Banner, EmptyState } from "./ui.jsx";

const QUICK_PROMPTS = ["More empathetic", "More concise", "More formal", "What policy applies here?"];
const STATUS_OPTIONS = ["New", "Transferred", "Waiting for Customer", "Closed"];
const CHANNELS = [
  { key: "email", label: "Email", icon: EnvelopeSimple },
  { key: "whatsapp", label: "WhatsApp", icon: WhatsappLogo },
  { key: "sms", label: "Text message", icon: ChatText },
];
const CHANNEL_KEY = "resolve-channel";
const MAILTO_SAFE_LENGTH = 1900; // longer links get cut off by some email apps

// Retryable hiccups read as warnings; anything that needs a fix reads as an error.
const SOFT_ERRORS = new Set(["rate_limited", "overloaded", "timeout", "offline", "network", "upstream_unreachable", "server_error", "empty", "bad_response"]);
// Problems that are fixed in Settings (key, credit, model…) get a shortcut there.
const SETUP_ERRORS = new Set([
  "missing_key",
  "invalid_key",
  "permission_denied",
  "model_not_found",
  "endpoint_not_found",
  "insufficient_credits",
  "missing_config",
  "all_providers_failed",
  "region_blocked",
  "function_missing",
  "blocked_by_host",
]);

// Hands a mailto:/sms: link to the device's own app. Clicking a link (instead of changing the page address)
// means the app never navigates away, even on a computer with no email program set up.
function openExternalLink(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener noreferrer";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const without = (obj, key) => {
  const { [key]: _drop, ...rest } = obj;
  return rest;
};

const textOf = (content) => (Array.isArray(content) ? (content.find((b) => b.type === "text") || {}).text || "" : content || "");
const imagesOf = (content) => (Array.isArray(content) ? content.filter((b) => b.type === "image") : []);
// What "Copy" and "Send to customer" use: the customer-ready draft from the newest assistant message that has one.
// (A later answer to a question — "what policy applies?" — has no draft, so the earlier draft stays current.)
// If the AI never marked a draft, the newest assistant message is used whole.
const lastReplyText = (item) => {
  const replies = [...((item && item.chat) || [])].reverse().filter((m) => m.role === "assistant" && !m.hidden);
  for (const m of replies) {
    const parts = splitDraft(textOf(m.content));
    if (parts.hasDraft) return parts.draft;
  }
  return replies.length ? textOf(replies[0].content) : "";
};

function Dots() {
  return (
    <span className="inline-flex items-center gap-1 ml-1" aria-hidden="true">
      <span className="rsv-dot" />
      <span className="rsv-dot" />
      <span className="rsv-dot" />
    </span>
  );
}

function Bubble({ role, content, kb }) {
  const isUser = role === "user";
  const images = imagesOf(content);
  const parts = isUser ? null : splitDraft(textOf(content));
  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-1`} data-msg="">

      <div
        className="max-w-[85%] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap break-words"
        style={isUser ? { backgroundColor: colors.black, color: colors.white } : { backgroundColor: colors.lightGray, color: colors.ink }}
      >
        {images.map((image, i) => (
          <img key={i} src={`data:${image.mediaType};base64,${image.data}`} alt="Attachment" className="rounded-md mb-2 max-h-40" />
        ))}
        {parts && parts.hasDraft ? (
          <>
            {parts.note && <p className="mb-3" data-testid="ai-note">{parts.note}</p>}
            <div className="rounded-md p-3" style={{ backgroundColor: colors.white }} data-testid="draft-block">
              <p className="text-[11px] font-medium mb-1" style={{ color: colors.sectionGray }}>Draft reply</p>
              {parts.draft}
            </div>
          </>
        ) : (
          textOf(content)
        )}
      </div>
      {!isUser && kb && kb.length > 0 && (
        <p className="text-[11px] px-1 max-w-[85%]" style={{ color: colors.gray }}>
          From your knowledge base: {kb.join(" · ")}
        </p>
      )}
    </div>
  );
}

function Thumb({ image, size = 40 }) {
  return <img src={`data:${image.mediaType};base64,${image.data}`} alt={image.name || "Attachment"} className="rounded-md object-cover shrink-0" style={{ width: size, height: size }} />;
}

// The customer's own words. Long messages are folded so they don't push the draft off screen,
// but the advisor can always open the whole thing.
function CustomerMessage({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240;
  return (
    <div>
      <p className={`text-sm font-normal whitespace-pre-wrap break-words ${long && !open ? "line-clamp-4" : ""}`} style={{ color: colors.ink }} data-testid="customer-message">
        {text}
      </p>
      {long && (
        <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-xs underline mt-1" style={{ color: colors.gray }} data-testid="customer-message-toggle">
          {open ? "Show less" : "Show full message"}
        </button>
      )}
    </div>
  );
}

export default function ChatPanel({
  item,
  onSendMessage,
  onChangeStatus,
  onRefresh,
  onNewCase,
  searching = false,
  onSendEmail,
  onUpdateContact,
  onBack,
  onOpenSettings,
  emailConfigured,
  resizeHandleProps,
}) {
  const [input, setInput] = useState("");
  const [pendingImage, setPendingImage] = useState(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [attachNotice, setAttachNotice] = useState(null);
  const [busy, setBusy] = useState({}); // case id → "sending" | "preparing"
  const [errors, setErrors] = useState({}); // case id → Error from the last failed call
  const [pendingBubbles, setPendingBubbles] = useState({}); // case id → the message being sent, shown right away
  const [copied, setCopied] = useState(false);

  const [sendOpen, setSendOpen] = useState(false);
  const [channel, setChannel] = useState(() => {
    const saved = loadJSON(CHANNEL_KEY, "email");
    return CHANNELS.some((c) => c.key === saved) ? saved : "email";
  });
  const [emailTo, setEmailTo] = useState("");
  const [phoneTo, setPhoneTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sendNotice, setSendNotice] = useState(null); // { kind, message }
  const [directSending, setDirectSending] = useState(false);
  const [afterSend, setAfterSend] = useState(null); // set once a channel has been opened

  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);
  const inflight = useRef(new Set());
  const lastAttempt = useRef({});
  const activeId = useRef(null);
  const attachSeq = useRef(0); // only the newest photo that finished preparing is attached
  const subjectEdited = useRef(false); // once the advisor types a subject, stop overwriting it
  activeId.current = item ? item.id : null;

  const itemId = item ? item.id : null;
  const chatLength = item && item.chat ? item.chat.length : 0;
  const state = itemId ? busy[itemId] : undefined;
  const error = itemId ? errors[itemId] : undefined;
  const pendingBubble = itemId ? pendingBubbles[itemId] : undefined;
  const isPreparing = state === "preparing";
  const isSending = state === "sending";
  // The AI fills in the category after the case opens, so the subject has to follow it.
  const defaultSubject = item && item.category ? `Re: ${item.category}` : "Re: your inquiry";

  // Switching cases starts a clean slate for the things that belong to one case.
  useEffect(() => {
    setInput("");
    attachSeq.current += 1; // a photo still being prepared for the previous case is dropped
    setPreparingImage(false);
    setPendingImage(null);
    setAttachNotice(null);
    setSendOpen(false);
    setSendNotice(null);
    setAfterSend(null);
    setCopied(false);
    subjectEdited.current = false;
    if (item) {
      setEmailTo(item.customerEmail || "");
      setPhoneTo(item.customerPhone || "");
      setSubject(defaultSubject);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  useEffect(() => {
    if (!subjectEdited.current) setSubject(defaultSubject);
  }, [defaultSubject]);

  // Follow the conversation. A reply taller than the window is shown from its first line — an advisor
  // reads a draft from the top — everything else keeps the newest message in view.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const visible = (item && item.chat ? item.chat : []).filter((m) => !m.hidden);
    const lastIsReply = visible.length > 0 && visible[visible.length - 1].role === "assistant" && !state && !error && !pendingBubble;
    if (lastIsReply) {
      const bubbles = box.querySelectorAll("[data-msg]");
      const last = bubbles[bubbles.length - 1];
      if (last && last.offsetHeight > box.clientHeight - 32) {
        box.scrollTop = Math.max(0, last.offsetTop - 12);
        return;
      }
    }
    box.scrollTop = box.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, chatLength, state, pendingBubble, error]);

  // A freshly pulled case starts with an empty chat — prepare it automatically
  // rather than making the advisor ask for a first draft.
  useEffect(() => {
    if (itemId && chatLength === 0) prepare(itemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, chatLength]);

  async function prepare(caseId) {
    if (inflight.current.has(caseId)) return;
    inflight.current.add(caseId);
    setBusy((b) => ({ ...b, [caseId]: "preparing" }));
    setErrors((e) => without(e, caseId));
    try {
      await onRefresh(caseId);
    } catch (err) {
      setErrors((e) => ({ ...e, [caseId]: err }));
    } finally {
      inflight.current.delete(caseId);
      setBusy((b) => without(b, caseId));
    }
  }

  async function deliver(caseId, value, image, { clearInput }) {
    if (inflight.current.has(caseId)) return;
    inflight.current.add(caseId);
    lastAttempt.current[caseId] = { value, image };
    setBusy((b) => ({ ...b, [caseId]: "sending" }));
    setErrors((e) => without(e, caseId));
    setPendingBubbles((p) => ({ ...p, [caseId]: { content: buildUserContent(value, image ? [image] : []) } }));
    try {
      await onSendMessage(caseId, value, image ? [image] : []);
      if (activeId.current === caseId) {
        if (clearInput) setInput("");
        setPendingImage(null);
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [caseId]: err }));
    } finally {
      inflight.current.delete(caseId);
      setBusy((b) => without(b, caseId));
      setPendingBubbles((p) => without(p, caseId));
    }
  }

  function handleSubmit() {
    const value = input.trim();
    if (!item || (!value && !pendingImage) || state || preparingImage) return;
    deliver(item.id, value, pendingImage, { clearInput: true });
  }

  function handleQuickPrompt(text) {
    if (!item || state) return;
    deliver(item.id, text, null, { clearInput: false });
  }

  function handleRetry() {
    if (!item) return;
    if (item.chat.length === 0) return prepare(item.id);
    const last = lastAttempt.current[item.id];
    if (last) deliver(item.id, last.value, last.image, { clearInput: true });
  }

  function handleStartOver() {
    if (!item || state) return;
    const visible = item.chat.filter((m) => !m.hidden).length;
    if (visible > 1 && !window.confirm("Start this case's chat over? The current conversation will be replaced with a fresh draft.")) return;
    prepare(item.id);
  }

  async function handleCopy(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setSendNotice({ kind: "warning", message: "Your browser wouldn't allow copying. Select the text and copy it by hand." });
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const seq = ++attachSeq.current;
    setAttachNotice(null);
    setPreparingImage(true);
    try {
      const image = await prepareImage(file);
      if (seq !== attachSeq.current) return; // the case changed (or a newer photo was chosen) meanwhile
      setPendingImage(image);
    } catch (err) {
      if (seq !== attachSeq.current) return;
      setPendingImage(null);
      setAttachNotice(err.message || "Couldn't attach that image.");
    } finally {
      if (seq === attachSeq.current) setPreparingImage(false);
    }
  }

  /* ───── sending the reply to the customer ───── */

  function openSendPanel() {
    setBody(lastReplyText(item));
    setSendNotice(null);
    setAfterSend(null);
    setSendOpen(true);
  }

  function chooseChannel(key) {
    setChannel(key);
    saveJSON(CHANNEL_KEY, key);
    setSendNotice(null);
    setAfterSend(null);
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo.trim());
  const phoneDigits = phoneTo.replace(/\D/g, "");
  const phoneValid = phoneDigits.length >= 7 && phoneDigits.length <= 15;
  const mailtoUrl = `mailto:${encodeURIComponent(emailTo.trim()).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}`;
  const canOpen = body.trim() && (channel === "email" ? emailValid : phoneValid);

  function handleOpenChannel() {
    if (!body.trim()) return;
    if (channel === "email") {
      if (!emailValid) return setSendNotice({ kind: "error", message: "That doesn't look like an email address — check it and try again." });
      if (mailtoUrl.length > MAILTO_SAFE_LENGTH) {
        setSendNotice({ kind: "warning", message: "This reply is long, so some email apps may cut it off. Use “Copy text” and paste it into your email to be safe." });
      }
      onUpdateContact(item.id, { customerEmail: emailTo.trim() });
      openExternalLink(mailtoUrl);
    } else if (channel === "whatsapp") {
      if (!phoneValid) return setSendNotice({ kind: "error", message: "That doesn't look like a phone number — include the country code, e.g. +233 24 123 4567." });
      if (/^\s*0/.test(phoneTo)) return setSendNotice({ kind: "error", message: "WhatsApp needs the country code instead of a leading 0 — for Ghana, +233 24 123 4567." });
      onUpdateContact(item.id, { customerPhone: phoneTo.trim() });
      window.open(`https://wa.me/${phoneDigits}?text=${encodeURIComponent(body)}`, "_blank", "noopener,noreferrer");
    } else {
      if (!phoneValid) return setSendNotice({ kind: "error", message: "That doesn't look like a phone number." });
      onUpdateContact(item.id, { customerPhone: phoneTo.trim() });
      openExternalLink(`sms:${phoneTo.replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(body)}`);
    }
    setAfterSend({ channel });
  }

  async function handleSendDirectly() {
    if (!emailValid || !body.trim() || directSending) return;
    setDirectSending(true);
    setSendNotice(null);
    try {
      await onSendEmail(item.id, { to: emailTo.trim(), subject: subject.trim(), body: body.trim() });
      onUpdateContact(item.id, { customerEmail: emailTo.trim() });
      setSendNotice({ kind: "success", message: `Sent to ${emailTo.trim()}.` });
      setAfterSend({ channel: "email", direct: true });
    } catch (err) {
      setSendNotice({ kind: "error", message: err.message || "Couldn't send that. Try again." });
    } finally {
      setDirectSending(false);
    }
  }

  const visibleMessages = (item && item.chat ? item.chat : []).filter((m) => !m.hidden);
  const details = (item && item.details) || {};
  const detailPills = [
    details.orderNumber && `Order ${details.orderNumber}`,
    details.sku && `Item ${details.sku}`,
    details.trackingNumber && `Tracking ${details.trackingNumber}`,
  ].filter(Boolean);
  const safeTrackingLink = details.trackingLink && /^https?:\/\//i.test(details.trackingLink) ? details.trackingLink : "";
  const attachments = (item && item.attachments) || [];

  const errorKind = error && SOFT_ERRORS.has(error.code) ? "warning" : "error";
  const errorLines = error && error.attempts && error.attempts.length > 1 ? error.attempts.map((a) => `${a.provider}${a.model ? ` (${a.model})` : ""}: ${a.message}`) : [];

  return (
    <div className="rsv-chat-panel relative flex flex-col rsv-screen" style={{ backgroundColor: colors.white }} data-testid="chat-panel">
      <div {...resizeHandleProps} className="hidden md:block absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10" style={{ marginLeft: "-2px" }} />

      <div className="shrink-0 flex items-center justify-between px-[16px] py-[12px]" style={{ borderBottom: `1px solid ${colors.border}` }}>
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onBack}
            className="md:hidden flex items-center justify-center w-[28px] h-[28px] -ml-1 rounded-full rsv-icon-btn"
            aria-label="Back to cases"
            data-testid="chat-back"
          >
            <ArrowLeft className="w-[18px] h-[18px]" style={{ color: colors.ink }} />
          </button>
          <p className="text-[16px] font-medium" style={{ color: colors.black }}>AI Assistant</p>
        </div>
        <div className="flex items-center gap-[8px]">
          <button
            onClick={handleStartOver}
            disabled={!item || Boolean(state)}
            className="flex items-center justify-center w-[24px] h-[24px] rounded-full disabled:opacity-40"
            style={{ backgroundColor: colors.bg }}
            title="Start this case's chat over"
            aria-label="Start this case's chat over"
            data-testid="chat-restart"
          >
            <ArrowClockwise className="w-[16px] h-[16px]" style={{ color: colors.ink }} />
          </button>
          <button onClick={onNewCase} disabled={searching} className="flex items-center justify-center w-[24px] h-[24px] rounded-full disabled:opacity-40" style={{ backgroundColor: colors.bg }} title="Get the next case" aria-label="Get the next case">
            <Plus className="w-[16px] h-[16px]" style={{ color: colors.ink }} />
          </button>
        </div>
      </div>

      {!item ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState icon={ChatsCircle} title="No case selected" description="Get the next case, or pick one from the list." />
        </div>
      ) : (
        <>
          <div className="shrink-0 flex flex-wrap items-center gap-2 px-[16px] py-2" style={{ borderBottom: `1px solid ${colors.border}` }} data-testid="case-toolbar">
            <GhostButton onClick={() => handleCopy(lastReplyText(item))} disabled={!lastReplyText(item)}>
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "Copied" : "Copy draft"}
            </GhostButton>
            <PrimaryButton className="ml-auto" onClick={openSendPanel} disabled={isPreparing || !lastReplyText(item)} data-testid="open-send-panel">
              <EnvelopeSimple className="w-3.5 h-3.5" /> Send to customer
            </PrimaryButton>
          </div>

          {sendOpen && (
            <div className="shrink-0 px-[16px] py-3 flex flex-col gap-2 max-h-[50vh] overflow-y-auto" style={{ borderBottom: `1px solid ${colors.border}` }} data-testid="send-panel">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium" style={{ color: colors.sectionGray }}>Send to customer</p>
                <button onClick={() => setSendOpen(false)} style={{ color: colors.gray }} aria-label="Close send panel">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Channel">
                {CHANNELS.map((c) => {
                  const Icon = c.icon;
                  const active = c.key === channel;
                  return (
                    <button
                      key={c.key}
                      role="tab"
                      aria-selected={active}
                      onClick={() => chooseChannel(c.key)}
                      className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-normal"
                      style={active ? { backgroundColor: colors.black, color: colors.white } : { backgroundColor: colors.lightGray, color: colors.ink }}
                    >
                      <Icon className="w-3.5 h-3.5" /> {c.label}
                    </button>
                  );
                })}
              </div>

              {channel === "email" ? (
                <>
                  <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="customer@example.com" inputMode="email" className="w-full rounded-lg p-2 text-sm rsv-input" aria-label="Customer email" />
                  <input value={subject} onChange={(e) => { subjectEdited.current = true; setSubject(e.target.value); }} placeholder="Subject" className="w-full rounded-lg p-2 text-sm rsv-input" aria-label="Subject" />
                </>
              ) : (
                <>
                  <input
                    value={phoneTo}
                    onChange={(e) => setPhoneTo(e.target.value)}
                    placeholder={channel === "whatsapp" ? "+233 24 123 4567" : "Customer's phone number"}
                    inputMode="tel"
                    className="w-full rounded-lg p-2 text-sm rsv-input"
                    aria-label="Customer phone number"
                  />
                  {channel === "whatsapp" && <p className="text-[11px]" style={{ color: colors.gray }}>Include the country code — WhatsApp needs it.</p>}
                </>
              )}
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} className="w-full rounded-lg p-2 text-sm resize-none rsv-input" aria-label="Message" />

              {sendNotice && <Banner kind={sendNotice.kind} message={sendNotice.message} testId="send-notice" />}
              {afterSend && (
                <Banner kind="info" message={afterSend.direct ? "Sent. Mark the case as waiting for the customer's reply?" : "Opened on your device. Once you've sent it, mark the case as waiting for the customer's reply."} testId="after-send">
                  {item.status !== "Waiting for Customer" && (
                    <button onClick={() => onChangeStatus(item.id, "Waiting for Customer")} className="text-sm font-medium mt-1 underline" style={{ color: semantic.info.fg }}>
                      Mark as Waiting for Customer
                    </button>
                  )}
                </Banner>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <GhostButton onClick={() => handleCopy(body)} disabled={!body.trim()}>
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? "Copied" : "Copy text"}
                  </GhostButton>
                  {channel === "email" && emailConfigured && (
                    <GhostButton onClick={handleSendDirectly} disabled={!emailValid || !body.trim() || directSending} data-testid="send-directly">
                      {directSending ? "Sending…" : "Send directly"}
                    </GhostButton>
                  )}
                </div>
                <PrimaryButton onClick={handleOpenChannel} disabled={!canOpen} data-testid="open-channel">
                  {channel === "email" ? "Open in email app" : channel === "whatsapp" ? "Open WhatsApp" : "Open messages"}
                </PrimaryButton>
              </div>
            </div>
          )}

          <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-y-auto px-[16px] py-4 flex flex-col gap-3" data-testid="chat-scroll">
            <div className="rounded-lg p-3 flex flex-col gap-2 shrink-0" style={{ backgroundColor: colors.bg }} data-testid="case-summary">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium" style={{ color: colors.sectionGray }}>Customer's message</p>
                <select
                  value={item.status}
                  onChange={(e) => onChangeStatus(item.id, e.target.value)}
                  className="text-xs font-normal rounded-full px-3 py-1 rsv-input"
                  style={{ backgroundColor: colors.white }}
                  aria-label="Case status"
                  data-testid="case-status"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <CustomerMessage key={item.id} text={item.message || ""} />
              {item.context && <p className="text-xs" style={{ color: colors.gray }}>Context: {item.context}</p>}

              {(detailPills.length > 0 || safeTrackingLink || attachments.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="case-details">
                  {detailPills.map((p) => (
                    <OutlinePill key={p} label={p} filled />
                  ))}
                  {safeTrackingLink && (
                    <a href={safeTrackingLink} target="_blank" rel="noopener noreferrer" className="text-xs underline" style={{ color: colors.ink }}>
                      Open tracking link
                    </a>
                  )}
                  {attachments.map((a, i) => (
                    <Thumb key={i} image={a} size={32} />
                  ))}
                </div>
              )}

              {(item.category || item.urgency) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.category && <OutlinePill label={item.category} filled />}
                  {item.urgency && <OutlinePill label={`${item.urgency} urgency`} filled />}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3" data-testid="chat-messages">
              {visibleMessages.map((m, i) => (
                <Bubble key={i} role={m.role} content={m.content} kb={m.kb} />
              ))}
              {pendingBubble && <Bubble role="user" content={pendingBubble.content} />}
              {(isPreparing || isSending) && (
                <div className="flex justify-start">
                  <div className="rounded-lg px-4 py-3 text-sm flex items-center" style={{ backgroundColor: colors.lightGray, color: colors.gray }} data-testid="chat-working">
                    {isPreparing ? "Reading the case and preparing a response" : "Thinking"}
                    <Dots />
                  </div>
                </div>
              )}
              {error && (
                <Banner kind={errorKind} message={error.message || "Something went wrong. Try again."} onRetry={handleRetry} testId="chat-error">
                  <span data-error-code={error.code || "unknown"} className="hidden" />
                  {errorLines.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {errorLines.map((line, i) => (
                        <li key={i} className="text-xs break-words" style={{ color: colors.ink }}>{line}</li>
                      ))}
                    </ul>
                  )}
                  {SETUP_ERRORS.has(error.code) && onOpenSettings && (
                    <button onClick={onOpenSettings} className="text-sm font-medium mt-1 ml-3 underline" style={{ color: errorKind === "warning" ? colors.ink : semantic.error.fg }} data-testid="chat-open-settings">
                      Open AI connection settings
                    </button>
                  )}
                </Banner>
              )}
            </div>
          </div>

          {!sendOpen && (
            <div className="shrink-0 px-[16px]" data-testid="quick-prompts">
              <div className="flex flex-wrap gap-1.5 pb-2.5">
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => handleQuickPrompt(p)}
                    disabled={Boolean(state)}
                    className="rsv-btn-ghost inline-flex items-center px-3 py-1 rounded-full text-xs font-normal disabled:opacity-40"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="shrink-0 flex flex-col gap-[12px] px-[20px] pb-[10px] pt-2">
        <div className="rsv-hint flex items-start gap-2 rounded-lg p-[10px] w-full" style={{ backgroundColor: semantic.info.fg }}>
          <Info className="w-4 h-4 mt-0.5 shrink-0" weight="fill" style={{ color: colors.white }} />
          <p className="text-[12px] font-normal" style={{ color: colors.white }}>Give context, review responses, and send to customers.</p>
        </div>

        {attachNotice && <Banner kind="warning" message={attachNotice} testId="attach-notice" />}

        <div className="rounded-lg p-[10px] min-h-[61px] flex flex-col justify-between" style={{ backgroundColor: colors.bg }}>
          {(pendingImage || preparingImage) && (
            <div className="flex items-center gap-2 mb-2 w-fit max-w-full rounded-md px-2 py-1" style={{ backgroundColor: colors.white }} data-testid="pending-image">
              {preparingImage ? (
                <>
                  <CircleNotch className="w-4 h-4 animate-spin" style={{ color: colors.gray }} />
                  <span className="text-xs" style={{ color: colors.gray }}>Preparing the photo…</span>
                </>
              ) : (
                <>
                  <Thumb image={pendingImage} size={32} />
                  <span className="text-xs truncate max-w-[160px]" style={{ color: colors.ink }}>{pendingImage.name}</span>
                  <button onClick={() => setPendingImage(null)} aria-label="Remove image">
                    <X className="w-3 h-3" style={{ color: colors.gray }} />
                  </button>
                </>
              )}
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onInput={(e) => {
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={!item}
            rows={1}
            placeholder="Chat with AI…"
            className="w-full bg-transparent text-[12px] resize-none focus:outline-none disabled:opacity-50"
            style={{ color: colors.ink }}
            aria-label="Message the AI assistant"
            data-testid="chat-input"
          />
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-2">
              <button className="opacity-40 cursor-not-allowed" title="Mention — coming soon" disabled aria-label="Mention (coming soon)">
                <At className="w-[18px] h-[18px]" style={{ color: colors.gray }} />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} data-testid="attach-input" />
              <button onClick={() => fileInputRef.current && fileInputRef.current.click()} disabled={!item || preparingImage} className="disabled:opacity-40" title="Attach an image" aria-label="Attach an image">
                <Paperclip className="w-[18px] h-[18px]" style={{ color: colors.ink }} />
              </button>
            </div>
            <button onClick={handleSubmit} disabled={!item || (!input.trim() && !pendingImage) || Boolean(state) || preparingImage} className="disabled:opacity-30" aria-label="Send" data-testid="chat-send">
              <ArrowUp className="w-[18px] h-[18px]" style={{ color: colors.ink }} />
            </button>
          </div>
        </div>

        <p className="text-[8px] font-normal text-center" style={{ color: colors.gray }}>AI can make mistakes, double check for clarity.</p>
      </div>
    </div>
  );
}
