import { useState } from "react";
import { ErrorBanner } from "./ErrorBanner";
import { EmptyState } from "./EmptyState";
import { IconInbox } from "./Icons";
import { ApiError } from "../api/client";
import { useNotes, type NoteTarget } from "../hooks/useNotes";

// Freeform CRM notes panel (CRM module "Notes"), attachable to a
// lead/deal/company/contact via `target`. Self-contained: fetches/writes
// through useNotes, which calls the real apps/api/src/routes/notes.ts
// endpoints. Intended drop-in spot: a lead/deal/company/contact detail
// page (not built as part of this change — see handback notes). Usage:
//   <NotesPanel tenantId={tenantId} projectId={projectId} target={{ leadId }} />

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function NotesPanel({
  tenantId,
  projectId,
  target,
}: {
  tenantId: string | undefined;
  projectId: string | undefined;
  target: NoteTarget;
}) {
  const { notes, error, loading, createNote, updateNote, deleteNote } = useNotes(tenantId, projectId, target);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  async function handleCreate() {
    if (!draft.trim()) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await createNote(draft.trim());
      setDraft("");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not save the note.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveEdit(noteId: string) {
    if (!editDraft.trim()) return;
    setActionError(null);
    try {
      await updateNote(noteId, editDraft.trim());
      setEditingId(null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not update the note.");
    }
  }

  async function handleDelete(noteId: string) {
    setActionError(null);
    try {
      await deleteNote(noteId);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete the note.");
    }
  }

  return (
    <section className="panel">
      <h2>Notes</h2>
      <ErrorBanner message={error} />
      <ErrorBanner message={actionError} />

      <div className="notes-composer">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note..."
          rows={3}
          disabled={submitting}
        />
        <button type="button" onClick={handleCreate} disabled={submitting || !draft.trim()}>
          {submitting ? "Saving..." : "Add note"}
        </button>
      </div>

      {loading && notes === null ? (
        <p className="muted">Loading...</p>
      ) : notes === null || notes.length === 0 ? (
        <EmptyState icon={<IconInbox width={22} height={22} />} title="No notes yet" hint="Add the first note above." />
      ) : (
        <ul className="notes-list">
          {notes.map((note) => (
            <li key={note.id} className="notes-list-item">
              {editingId === note.id ? (
                <>
                  <textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} rows={3} />
                  <div className="notes-list-item-actions">
                    <button type="button" onClick={() => handleSaveEdit(note.id)}>
                      Save
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="notes-list-item-body">{note.body}</p>
                  <div className="notes-list-item-footer">
                    <time dateTime={note.updated_at} className="muted">
                      {formatTimestamp(note.updated_at)}
                    </time>
                    <div className="notes-list-item-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(note.id);
                          setEditDraft(note.body);
                        }}
                      >
                        Edit
                      </button>
                      <button type="button" onClick={() => handleDelete(note.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
