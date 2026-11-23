import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { EmptyState } from "../components/EmptyState";
import { ErrorBanner } from "../components/ErrorBanner";
import { StatCard, StatGrid } from "../components/StatCard";
import { IconBuilding, IconUsers } from "../components/Icons";
import { api, ApiError } from "../api/client";
import type { Company, Contact, Project } from "../api/types";

// CRM module: first-class companies + contacts
// (packages/db/migrations/302_create_companies.sql /
// 307_create_contacts.sql), distinct from leads.company (free text) and
// leads themselves. Every number/row here is a direct read from
// GET .../companies and GET .../contacts (apps/api/src/routes/companies.ts
// / contacts.ts) — nothing here is estimated or fabricated. Same
// API-calling/empty-state/error-banner conventions as SalesPipelinePage.
export function CompaniesPage() {
  const { tenantId, projectId } = useParams<{ tenantId: string; projectId: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsError, setContactsError] = useState<string | null>(null);

  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyDomain, setNewCompanyDomain] = useState("");
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [createCompanyError, setCreateCompanyError] = useState<string | null>(null);

  const [newContactName, setNewContactName] = useState("");
  const [newContactEmail, setNewContactEmail] = useState("");
  const [newContactTitle, setNewContactTitle] = useState("");
  const [creatingContact, setCreatingContact] = useState(false);
  const [createContactError, setCreateContactError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId || !projectId) return;
    try {
      const [projectRes, companiesRes] = await Promise.all([
        api.get<{ project: Project }>(`/tenants/${tenantId}/projects/${projectId}`),
        api.get<{ companies: Company[] }>(`/tenants/${tenantId}/projects/${projectId}/companies`),
      ]);
      setProject(projectRes.project);
      setCompanies(companiesRes.companies);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load companies for this project.");
    }
  }, [tenantId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const loadContacts = useCallback(
    async (companyId: string) => {
      if (!tenantId || !projectId) return;
      setContactsError(null);
      try {
        const res = await api.get<{ contacts: Contact[] }>(
          `/tenants/${tenantId}/projects/${projectId}/contacts?companyId=${companyId}`,
        );
        setContacts(res.contacts);
      } catch (err) {
        setContactsError(err instanceof ApiError ? err.message : "Could not load contacts for this company.");
      }
    },
    [tenantId, projectId],
  );

  const selectCompany = useCallback(
    (companyId: string) => {
      setSelectedCompanyId(companyId);
      setContacts(null);
      loadContacts(companyId);
    },
    [loadContacts],
  );

  const createCompany = useCallback(async () => {
    if (!tenantId || !projectId || !newCompanyName.trim()) return;
    setCreatingCompany(true);
    setCreateCompanyError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/companies`, {
        name: newCompanyName.trim(),
        domain: newCompanyDomain.trim() || undefined,
      });
      setNewCompanyName("");
      setNewCompanyDomain("");
      load();
    } catch (err) {
      setCreateCompanyError(err instanceof ApiError ? err.message : "Could not create this company.");
    } finally {
      setCreatingCompany(false);
    }
  }, [tenantId, projectId, newCompanyName, newCompanyDomain, load]);

  const createContact = useCallback(async () => {
    if (!tenantId || !projectId || !selectedCompanyId || !newContactName.trim()) return;
    setCreatingContact(true);
    setCreateContactError(null);
    try {
      await api.post(`/tenants/${tenantId}/projects/${projectId}/contacts`, {
        name: newContactName.trim(),
        companyId: selectedCompanyId,
        email: newContactEmail.trim() || undefined,
        title: newContactTitle.trim() || undefined,
      });
      setNewContactName("");
      setNewContactEmail("");
      setNewContactTitle("");
      loadContacts(selectedCompanyId);
    } catch (err) {
      setCreateContactError(err instanceof ApiError ? err.message : "Could not create this contact.");
    } finally {
      setCreatingContact(false);
    }
  }, [tenantId, projectId, selectedCompanyId, newContactName, newContactEmail, newContactTitle, loadContacts]);

  const selectedCompany = companies?.find((c) => c.id === selectedCompanyId) ?? null;

  return (
    <Layout
      crumbs={[
        { label: "Organizations", to: "/" },
        { label: "Organization", to: `/tenants/${tenantId}` },
        { label: project?.name ?? "...", to: `/tenants/${tenantId}/projects/${projectId}` },
        { label: "Companies" },
      ]}
      projectName={project?.name}
    >
      <ErrorBanner message={loadError} />

      <section className="panel">
        <h1>Companies</h1>
        <p className="muted">
          Real, first-class company records for this project — distinct from the free-text company a lead may have
          typed into a form. Select a company below to see its contacts.
        </p>
        <div className="form-row">
          <input
            type="text"
            placeholder="Company name"
            value={newCompanyName}
            onChange={(e) => setNewCompanyName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Domain (optional)"
            value={newCompanyDomain}
            onChange={(e) => setNewCompanyDomain(e.target.value)}
          />
          <button type="button" onClick={createCompany} disabled={creatingCompany || !newCompanyName.trim()}>
            {creatingCompany ? "Creating..." : "Add company"}
          </button>
        </div>
        <ErrorBanner message={createCompanyError} />
      </section>

      {companies === null ? (
        <section className="panel">
          <p className="muted">Loading...</p>
        </section>
      ) : (
        <>
          <StatGrid>
            <StatCard icon={<IconBuilding />} label="Companies" value={companies.length} />
            <StatCard icon={<IconUsers />} label="Contacts (selected company)" value={contacts?.length ?? 0} />
          </StatGrid>

          <section className="panel">
            <h2>All companies</h2>
            {companies.length === 0 ? (
              <EmptyState title="No companies yet" hint="Add a company above to start tracking contacts for it." />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Domain</th>
                    <th>Industry</th>
                    <th>Size</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>{c.domain ?? "—"}</td>
                      <td>{c.industry ?? "—"}</td>
                      <td>{c.size_range ?? "—"}</td>
                      <td>
                        <button type="button" onClick={() => selectCompany(c.id)}>
                          {selectedCompanyId === c.id ? "Selected" : "View contacts"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {selectedCompany ? (
            <section className="panel">
              <h2>Contacts at {selectedCompany.name}</h2>
              <ErrorBanner message={contactsError} />

              <div className="form-row">
                <input
                  type="text"
                  placeholder="Contact name"
                  value={newContactName}
                  onChange={(e) => setNewContactName(e.target.value)}
                />
                <input
                  type="email"
                  placeholder="Email (optional)"
                  value={newContactEmail}
                  onChange={(e) => setNewContactEmail(e.target.value)}
                />
                <input
                  type="text"
                  placeholder="Title (optional)"
                  value={newContactTitle}
                  onChange={(e) => setNewContactTitle(e.target.value)}
                />
                <button type="button" onClick={createContact} disabled={creatingContact || !newContactName.trim()}>
                  {creatingContact ? "Creating..." : "Add contact"}
                </button>
              </div>
              <ErrorBanner message={createContactError} />

              {contacts === null ? (
                <p className="muted">Loading contacts...</p>
              ) : contacts.length === 0 ? (
                <EmptyState title="No contacts yet" hint="Add a contact above to start tracking people at this company." />
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Title</th>
                      <th>Email</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((contact) => (
                      <tr key={contact.id}>
                        <td>{contact.name}</td>
                        <td>{contact.title ?? "—"}</td>
                        <td>{contact.email ?? "—"}</td>
                        <td>{contact.phone ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ) : null}
        </>
      )}
    </Layout>
  );
}
