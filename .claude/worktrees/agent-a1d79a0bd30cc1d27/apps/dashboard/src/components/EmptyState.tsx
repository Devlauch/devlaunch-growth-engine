import type { ReactNode } from "react";
import { IconInbox } from "./Icons";

// Every list/table in this app must use this instead of rendering nothing
// or, worse, placeholder/fabricated rows — "no data yet" is a hard spec
// rule (Phase 1 acceptance criteria).
export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">{icon ?? <IconInbox width={22} height={22} />}</span>
      <p className="empty-state-title">{title}</p>
      {hint ? <p className="empty-state-hint">{hint}</p> : null}
    </div>
  );
}
