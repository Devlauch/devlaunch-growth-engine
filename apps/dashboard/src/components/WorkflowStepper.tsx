// Ported from Phase 2 (Agent C2), rebuilt against master's current
// dashboard conventions rather than phase2's older ones: reuses the
// .steps/.step/.step-done/.step-check classes master's own ProjectPage.tsx
// onboarding checklist already established (styles.css), via a new
// .steps-horizontal layout modifier, instead of introducing a second,
// competing stepper style. No LeadWorkflowState type/API is assumed here —
// master has no such endpoint — every prop is a plain boolean/string the
// caller already has from data it loaded for its own purposes (see
// LeadDetailPage.tsx's usage).
//
// The desired workflow narrative: Prospect -> Scored Lead -> CRM
// Assignment -> Qualified Lead -> Opportunity -> Customer. Each step's
// "done" flag is one real, independent signal, never a cascade — e.g. a
// deal can exist without the lead's current status being 'qualified'
// (nothing in this schema forces that transition), and the stepper
// honestly shows that rather than assuming one step implies another:
//   - Prospect:        always true (the lead row exists — we're rendering it)
//   - Scored Lead:     a lead_scores row exists (hasScore)
//   - CRM Assignment:  a lead_assignments row exists (hasAssignment)
//   - Qualified Lead:  leads.status === 'qualified' right now (qualified)
//   - Opportunity:     at least one deals row exists (hasDeal)
//   - Customer:        at least one deal has reached stage 'won' — the
//     same condition that puts a lead in the real `customers` VIEW
//     (278_create_deals.sql) — computed from data already loaded, not a
//     second network call to GET /deals/customers.

export interface WorkflowStepperProps {
  qualified: boolean;
  hasScore: boolean;
  hasAssignment: boolean;
  hasDeal: boolean;
  dealStage?: string | null;
  isCustomer: boolean;
}

export function WorkflowStepper({ qualified, hasScore, hasAssignment, hasDeal, dealStage, isCustomer }: WorkflowStepperProps) {
  const steps: { label: string; done: boolean; hint?: string }[] = [
    { label: "Prospect", done: true },
    { label: "Scored Lead", done: hasScore },
    { label: "CRM Assignment", done: hasAssignment },
    { label: "Qualified Lead", done: qualified },
    {
      label: "Opportunity",
      done: hasDeal,
      hint: hasDeal && dealStage ? `Deal stage: ${dealStage}` : undefined,
    },
    { label: "Customer", done: isCustomer },
  ];

  return (
    <ol className="steps steps-horizontal">
      {steps.map((s, i) => (
        <li key={s.label} className={s.done ? "step step-done" : "step"}>
          <span className="step-check">{s.done ? "✓" : i + 1}</span>
          <span>
            {s.label}
            {s.hint ? <span className="step-hint"> ({s.hint})</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
