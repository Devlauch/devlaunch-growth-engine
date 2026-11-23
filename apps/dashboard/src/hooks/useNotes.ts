import { useCallback, useEffect, useState } from "react";
import { api, ApiError, API_BASE_URL, getAccessToken } from "../api/client";

export interface Note {
  id: string;
  lead_id: string | null;
  deal_id: string | null;
  company_id: string | null;
  contact_id: string | null;
  body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteTarget {
  leadId?: string;
  dealId?: string;
  companyId?: string;
  contactId?: string;
}

/**
 * apps/dashboard/src/api/client.ts's `api` helper only exposes
 * get/post/patch (no delete) as of this writing. Rather than edit that
 * shared, concurrently-touched file, DELETE is implemented here directly
 * with the same auth-header convention client.ts uses.
 */
async function apiDelete(path: string): Promise<void> {
  const token = getAccessToken();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}${path}`, { method: "DELETE", headers });
  if (!res.ok && res.status !== 204) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) message = body.error.message;
    } catch {
      // body wasn't JSON
    }
    throw new ApiError(res.status, message);
  }
}

/**
 * Notes CRUD for one target entity (lead/deal/company/contact), backed by
 * the real apps/api/src/routes/notes.ts endpoints. Self-contained: a
 * lead/deal/company/contact detail page can drop in <NotesPanel /> with
 * just a tenantId/projectId and a NoteTarget.
 */
export function useNotes(tenantId: string | undefined, projectId: string | undefined, target: NoteTarget) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const query = new URLSearchParams();
  if (target.leadId) query.set("leadId", target.leadId);
  if (target.dealId) query.set("dealId", target.dealId);
  if (target.companyId) query.set("companyId", target.companyId);
  if (target.contactId) query.set("contactId", target.contactId);
  const queryString = query.toString();

  const reload = useCallback(async () => {
    if (!tenantId || !projectId || queryString === "") return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ notes: Note[] }>(`/tenants/${tenantId}/projects/${projectId}/notes?${queryString}`);
      setNotes(res.notes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load notes.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, projectId, queryString]);

  useEffect(() => {
    reload();
  }, [reload]);

  const createNote = useCallback(
    async (body: string) => {
      if (!tenantId || !projectId) return;
      await api.post(`/tenants/${tenantId}/projects/${projectId}/notes`, { ...target, body });
      await reload();
    },
    [tenantId, projectId, target, reload],
  );

  const updateNote = useCallback(
    async (noteId: string, body: string) => {
      if (!tenantId || !projectId) return;
      await api.patch(`/tenants/${tenantId}/projects/${projectId}/notes/${noteId}`, { body });
      await reload();
    },
    [tenantId, projectId, reload],
  );

  const deleteNote = useCallback(
    async (noteId: string) => {
      if (!tenantId || !projectId) return;
      await apiDelete(`/tenants/${tenantId}/projects/${projectId}/notes/${noteId}`);
      await reload();
    },
    [tenantId, projectId, reload],
  );

  return { notes, error, loading, reload, createNote, updateNote, deleteNote };
}
