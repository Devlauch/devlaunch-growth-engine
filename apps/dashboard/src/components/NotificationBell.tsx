import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Notification } from "../api/types";
import { IconBell } from "./Icons";

/**
 * Real notification bell: a real unread count (never fabricated — it's
 * exactly what GET /tenants/:tenantId/notifications returns) and a
 * dropdown of the user's own real notifications, with click-through to the
 * linked resource and mark-as-read. There is no email/WhatsApp sending
 * anywhere in this app — this is the one real notification surface (see
 * apps/api/src/lib/notify.ts).
 */
export function NotificationBell({ tenantId }: { tenantId: string }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ notifications: Notification[]; unreadCount: number }>(
        `/tenants/${tenantId}/notifications?limit=20`,
      );
      setNotifications(res.notifications);
      setUnreadCount(res.unreadCount);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load notifications.");
    }
  }, [tenantId]);

  // Poll for the real unread count periodically, same pattern as any other
  // "keep this panel fresh" surface in this app — no fabricated count
  // between polls, just whatever was last actually fetched.
  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function markRead(notification: Notification) {
    if (notification.read_at) return;
    try {
      await api.post(`/tenants/${tenantId}/notifications/${notification.id}/read`);
      setNotifications((prev) =>
        prev ? prev.map((n) => (n.id === notification.id ? { ...n, read_at: new Date().toISOString() } : n)) : prev,
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // Best-effort: leave the item unread in the UI if the request fails
      // rather than lying about its state.
    }
  }

  async function handleSelect(notification: Notification) {
    await markRead(notification);
    setOpen(false);
    if (notification.link_url) {
      navigate(notification.link_url);
    }
  }

  async function handleMarkAllRead() {
    try {
      await api.post(`/tenants/${tenantId}/notifications/mark-all-read`);
      setNotifications((prev) => (prev ? prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })) : prev));
      setUnreadCount(0);
    } catch {
      // ignore — next poll will reconcile the real state
    }
  }

  return (
    <div className="notification-bell" ref={containerRef}>
      <button
        type="button"
        className="header-bell"
        aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
        onClick={() => setOpen((v) => !v)}
      >
        <IconBell width={18} height={18} />
        {unreadCount > 0 ? <span className="notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
      </button>

      {open ? (
        <div className="notification-dropdown" role="menu">
          <div className="notification-dropdown-header">
            <strong>Notifications</strong>
            {unreadCount > 0 ? (
              <button type="button" className="btn-link" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            ) : null}
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          {notifications === null ? (
            <p className="muted notification-dropdown-empty">Loading...</p>
          ) : notifications.length === 0 ? (
            <p className="muted notification-dropdown-empty">No notifications yet.</p>
          ) : (
            <ul className="notification-list">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={n.read_at ? "notification-item" : "notification-item notification-item-unread"}
                  onClick={() => handleSelect(n)}
                >
                  <div className="notification-item-title">{n.title}</div>
                  <div className="notification-item-body">{n.body}</div>
                  <div className="notification-item-time">{new Date(n.created_at).toLocaleString()}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
