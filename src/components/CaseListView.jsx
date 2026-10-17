import { useRef, useState } from "react";
import { CaretRight, CircleNotch, FolderPlus, Share, Folder, FolderUser, Tray, MagicWand, Paperclip, X } from "@phosphor-icons/react";
import { colors } from "../lib/colors.js";
import { truncate } from "../lib/kb.js";
import { prepareImage } from "../lib/image.js";
import { Card, IconPill, OutlinePill, PrimaryButton, GhostButton, Banner, EmptyState } from "./ui.jsx";

const STATUS_ICON = {
  New: FolderPlus,
  Transferred: Share,
  Closed: Folder,
  "Waiting for Customer": FolderUser,
};
const MAX_ATTACHMENTS = 3;

function GetNextCaseCard({ onGetNextCase, searching }) {
  return (
    <Card className="p-5 sm:p-6 flex items-center justify-between gap-4">
      <div>
        <p className="text-sm font-medium" style={{ color: colors.black }}>Get the next case</p>
        <p className="text-xs mt-1" style={{ color: colors.gray }}>
          Pulls the next case waiting to be worked. The assistant starts preparing a response right away.
        </p>
      </div>
      <PrimaryButton onClick={onGetNextCase} disabled={searching} className="shrink-0" data-testid="get-next-case">
        {searching ? (
          <>
            <CircleNotch className="w-4 h-4 animate-spin" /> Searching…
          </>
        ) : (
          <>
            <MagicWand className="w-4 h-4" /> Get next case
          </>
        )}
      </PrimaryButton>
    </Card>
  );
}

// A placeholder row that sits at the top of the list while the next case is being found.
function SearchingRow() {
  return (
    <div className="rounded-lg p-4 flex flex-col gap-3 animate-pulse" style={{ border: `1px dashed ${colors.gray}` }} data-testid="searching-row" aria-hidden="true">
      <div className="h-3 rounded-full w-3/4" style={{ backgroundColor: colors.lightGray }} />
      <div className="flex gap-2">
        <div className="h-5 rounded-full w-16" style={{ backgroundColor: colors.lightGray }} />
        <div className="h-5 rounded-full w-24" style={{ backgroundColor: colors.lightGray }} />
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, inputMode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium mb-1" style={{ color: colors.sectionGray }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode={inputMode} className="w-full rounded-lg p-3 text-sm rsv-input" />
    </label>
  );
}

export function NewCaseForm({ onCreate, kbCount, onGoToKb, autoFocus }) {
  const [message, setMessage] = useState("");
  const [context, setContext] = useState("");
  const [orderNumber, setOrderNumber] = useState("");
  const [sku, setSku] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingLink, setTrackingLink] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      setError(`You can attach up to ${MAX_ATTACHMENTS} photos to a case.`);
      return;
    }
    setError("");
    setPreparing(true);
    try {
      const image = await prepareImage(file);
      setAttachments((list) => [...list, image]);
    } catch (err) {
      setError(err.message || "Couldn't attach that image.");
    } finally {
      setPreparing(false);
    }
  }

  async function handleSubmit() {
    if (!message.trim() || submitting) return;
    const link = trackingLink.trim();
    if (link && !/^https?:\/\/\S+$/i.test(link)) {
      setError("The tracking link should start with http:// or https://");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onCreate(
        message.trim(),
        context.trim(),
        { orderNumber: orderNumber.trim(), sku: sku.trim(), trackingNumber: trackingNumber.trim(), trackingLink: link },
        attachments
      );
      setMessage("");
      setContext("");
      setOrderNumber("");
      setSku("");
      setTrackingNumber("");
      setTrackingLink("");
      setAttachments([]);
    } catch (err) {
      setError(err.message || "Couldn't start that case. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <label className="block text-sm font-medium mb-2" style={{ color: colors.black }}>Paste a case manually</label>
      <textarea
        autoFocus={autoFocus}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder="Paste what the customer wrote…"
        className="w-full rounded-lg p-3 text-sm resize-none rsv-input"
        data-testid="new-case-message"
      />
      <input
        value={context}
        onChange={(e) => setContext(e.target.value)}
        placeholder="Extra context (optional) — account type, what you've already tried…"
        className="w-full rounded-lg p-3 text-sm rsv-input mt-3"
      />

      <p className="text-xs font-medium mt-4 mb-2" style={{ color: colors.sectionGray }}>What the customer gave you (all optional)</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Order number" value={orderNumber} onChange={setOrderNumber} placeholder="e.g. 48291" />
        <Field label="Item / SKU" value={sku} onChange={setSku} placeholder="e.g. BLD-700-BLK" />
        <Field label="Tracking number" value={trackingNumber} onChange={setTrackingNumber} placeholder="e.g. GH4829100231" />
        <Field label="Tracking link" value={trackingLink} onChange={setTrackingLink} placeholder="https://…" inputMode="url" />
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleFile} data-testid="new-case-file" />
        <GhostButton onClick={() => fileRef.current && fileRef.current.click()} disabled={preparing || attachments.length >= MAX_ATTACHMENTS}>
          {preparing ? <CircleNotch className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
          {preparing ? "Preparing…" : "Attach photos"}
        </GhostButton>
        {attachments.map((a, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 rounded-md pl-1 pr-2 py-1" style={{ backgroundColor: colors.bg }}>
            <img src={`data:${a.mediaType};base64,${a.data}`} alt={a.name || "Attachment"} className="w-7 h-7 rounded object-cover" />
            <button onClick={() => setAttachments((list) => list.filter((_, j) => j !== i))} aria-label="Remove photo">
              <X className="w-3 h-3" style={{ color: colors.gray }} />
            </button>
          </span>
        ))}
      </div>

      {error && <Banner kind="error" message={error} className="mt-3" />}
      {kbCount === 0 && (
        <p className="text-xs mt-3" style={{ color: colors.gray }}>
          Tip: add a few entries to your{" "}
          <button onClick={onGoToKb} className="underline font-medium" style={{ color: colors.gray }}>
            knowledge base
          </button>{" "}
          so replies can reference your policies.
        </p>
      )}
      <div className="flex justify-end mt-4">
        <PrimaryButton onClick={handleSubmit} disabled={!message.trim() || submitting || preparing} data-testid="start-case">
          {submitting ? (
            <>
              <CircleNotch className="w-4 h-4 animate-spin" /> Starting…
            </>
          ) : (
            <>Start case →</>
          )}
        </PrimaryButton>
      </div>
    </Card>
  );
}

export function CaseCard({ item, selected, onClick }) {
  const Icon = STATUS_ICON[item.status] || FolderPlus;
  const order = item.details && item.details.orderNumber;
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-lg p-4 rsv-history-item"
      style={{ backgroundColor: colors.white, border: `1px solid ${selected ? colors.black : colors.border}` }}
      data-testid="case-card"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <span className="text-sm font-normal" style={{ color: colors.ink }}>
          {truncate(item.message, 72)}
        </span>
        <CaretRight className="w-4 h-4 shrink-0 mt-0.5" style={{ color: colors.gray }} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <IconPill icon={Icon} label={item.status} />
        {item.category && <OutlinePill label={item.category} />}
        {item.urgency && <OutlinePill label={`${item.urgency} urgency`} />}
        {order && <OutlinePill label={`Order ${order}`} />}
      </div>
    </button>
  );
}

export default function CaseListView({ cases, statusFilter, selectedCaseId, onSelectCase, onGetNextCase, searching = false, onCreateCase, kbCount, onGoToKb, focusForm }) {
  const [showManual, setShowManual] = useState(false);
  const filtered = statusFilter ? cases.filter((c) => c.status === statusFilter) : cases;

  return (
    <div className="flex flex-col gap-6">
      <GetNextCaseCard onGetNextCase={onGetNextCase} searching={searching} />

      {showManual ? (
        <NewCaseForm onCreate={onCreateCase} kbCount={kbCount} onGoToKb={onGoToKb} autoFocus={focusForm} />
      ) : (
        <button onClick={() => setShowManual(true)} className="text-xs font-medium underline self-start" style={{ color: colors.gray }} data-testid="show-manual">
          Or paste a specific case manually
        </button>
      )}

      <div>
        <p className="text-xs font-medium mb-3" style={{ color: colors.gray }}>
          {statusFilter ? statusFilter : "All cases"}
        </p>
        {filtered.length === 0 && !searching ? (
          <EmptyState icon={Tray} title="No cases here yet" description={statusFilter ? `Nothing marked "${statusFilter}" yet.` : "Get the next case above to see it here."} />
        ) : (
          <div className="flex flex-col gap-2">
            {searching && !statusFilter && <SearchingRow />}
            {filtered.map((c) => (
              <CaseCard key={c.id} item={c} selected={c.id === selectedCaseId} onClick={() => onSelectCase(c.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
