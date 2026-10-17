import { useRef, useState } from "react";
import { MagnifyingGlass, Plus, PencilSimple, Trash, Book, UploadSimple } from "@phosphor-icons/react";
import { colors } from "../lib/colors.js";
import { truncate, parseKbFile, KB_IMPORT_ACCEPT } from "../lib/kb.js";
import { Card, EmptyState, IconButton, PrimaryButton, GhostButton, Banner } from "./ui.jsx";

function KbEntryForm({ initialTitle, initialContent, onSave, onCancel, saveLabel = "Save entry" }) {
  const [title, setTitle] = useState(initialTitle || "");
  const [content, setContent] = useState(initialContent || "");
  const canSave = title.trim() && content.trim();

  return (
    <Card className="p-6 sm:p-8">
      <label className="block text-sm font-medium mb-2" style={{ color: colors.black }}>Title</label>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Refund policy for digital goods"
        className="w-full rounded-lg p-3 text-sm rsv-input mb-4"
      />
      <label className="block text-sm font-medium mb-2" style={{ color: colors.black }}>Answer or policy</label>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={5}
        placeholder="What should the advisor say or do?"
        className="w-full rounded-lg p-3 text-sm resize-none rsv-input"
      />
      <div className="flex justify-end gap-2 mt-4">
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton onClick={() => canSave && onSave({ title: title.trim(), content: content.trim() })} disabled={!canSave}>
          {saveLabel}
        </PrimaryButton>
      </div>
    </Card>
  );
}

export default function KnowledgeBaseView({ kb, onUpdateKb }) {
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [notice, setNotice] = useState(null); // { kind, message } after an import
  const fileInputRef = useRef(null);

  const editingEntry = editingId ? kb.find((e) => e.id === editingId) : null;
  const filtered = kb.filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q);
  });

  function openNew() {
    setEditingId(null);
    setFormOpen(true);
  }
  function startEdit(id) {
    setEditingId(id);
    setFormOpen(true);
  }
  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
  }
  function handleSave(data) {
    if (editingId) {
      onUpdateKb(kb.map((e) => (e.id === editingId ? { ...e, ...data } : e)));
    } else {
      onUpdateKb([{ id: `kb-${Date.now()}`, ...data, createdAt: new Date().toISOString() }, ...kb]);
    }
    closeForm();
  }
  function handleDelete(id) {
    onUpdateKb(kb.filter((e) => e.id !== id));
  }

  async function handleImport(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setNotice(null);
    try {
      const text = await file.text();
      const { entries, skipped } = parseKbFile(file.name, text, file.size);
      const stamp = Date.now();
      const created = new Date().toISOString();
      const fresh = entries.map((entry, i) => ({ id: `kb-${stamp}-${i}`, ...entry, source: file.name, createdAt: created }));
      onUpdateKb([...fresh, ...kb]);
      setNotice({
        kind: "success",
        message: `Added ${fresh.length} ${fresh.length === 1 ? "entry" : "entries"} from ${file.name}.${skipped ? ` ${skipped} more were left out (the limit is 300 per file).` : ""}`,
      });
    } catch (err) {
      setNotice({ kind: "error", message: err.message || "Couldn't read that file." });
    }
  }

  return (
    <div>
      <h2 className="text-base font-medium mb-4" style={{ color: colors.black }}>Knowledge base</h2>

      {formOpen ? (
        <KbEntryForm
          initialTitle={editingEntry ? editingEntry.title : ""}
          initialContent={editingEntry ? editingEntry.content : ""}
          onCancel={closeForm}
          onSave={handleSave}
          saveLabel={editingEntry ? "Save changes" : "Add entry"}
        />
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <MagnifyingGlass className="w-4 h-4" style={{ color: colors.gray }} />
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search entries…"
                className="w-full rounded-full pl-11 pr-4 py-3 text-sm rsv-input"
              />
            </div>
            <input ref={fileInputRef} type="file" accept={KB_IMPORT_ACCEPT} className="hidden" onChange={handleImport} data-testid="kb-file-input" />
            <GhostButton onClick={() => fileInputRef.current && fileInputRef.current.click()} className="whitespace-nowrap justify-center">
              <UploadSimple className="w-4 h-4" /> Import file
            </GhostButton>
            <PrimaryButton onClick={openNew} className="whitespace-nowrap">
              <Plus className="w-4 h-4" /> New entry
            </PrimaryButton>
          </div>

          {notice && <Banner kind={notice.kind} message={notice.message} className="mb-4" testId="kb-notice" />}
          {kb.length === 0 && !notice && (
            <p className="text-xs mb-4" style={{ color: colors.gray }}>
              Tip: import a .txt, .md, .csv or .json file — a heading, a title column, or a {"{title, content}"} list becomes one entry each.
            </p>
          )}

          {filtered.length === 0 ? (
            <EmptyState
              icon={Book}
              title={kb.length === 0 ? "No entries yet" : "No matches"}
              description={kb.length === 0 ? "Add your first FAQ or policy — or import a file — so drafts can reference it." : "Try a different search term."}
              action={kb.length === 0 ? { label: "Add entry", onClick: openNew } : null}
            />
          ) : (
            <div className="space-y-3">
              {filtered.map((entry) => (
                <Card key={entry.id} className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium" style={{ color: colors.black }}>{entry.title}</h3>
                      <p className="text-sm mt-1" style={{ color: colors.gray }}>{truncate(entry.content, 140)}</p>
                      {entry.source && <p className="text-xs mt-2" style={{ color: colors.gray }}>From {entry.source}</p>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <IconButton onClick={() => startEdit(entry.id)} ariaLabel="Edit entry">
                        <PencilSimple className="w-4 h-4" />
                      </IconButton>
                      <IconButton onClick={() => handleDelete(entry.id)} ariaLabel="Delete entry">
                        <Trash className="w-4 h-4" />
                      </IconButton>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
