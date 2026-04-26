import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DollarSign,
  FileImage,
  Info,
  Loader2,
  Lock,
  Mail,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wrench,
  X
} from "lucide-react";
import { api, money, moneyRange, vehicleName } from "./api";
import { isSupabaseConfigured, supabase } from "./supabase";
import type {
  AutonomyStatus,
  Dashboard,
  Insight,
  MaintenanceItem,
  Provider,
  RecallRecord,
  SubscriptionStatus,
  Task,
  UploadedDocument,
  Vehicle
} from "./types";

type Tab = "status" | "tasks" | "command" | "history" | "settings";
type FormId = "insurance" | "loan" | "fuel" | "preferred_shop";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  if (loading) return <Shell><div className="panel">Loading secure session…</div></Shell>;
  if (!isSupabaseConfigured) return <Shell><SetupNotice /></Shell>;
  if (!session) return <Shell><AuthPanel /></Shell>;
  return <Product session={session} />;
}

// ============================================================
// Shell + auth
// ============================================================
function Shell({ children }: { children: React.ReactNode }) {
  return <main className="app-shell">{children}</main>;
}

function SetupNotice() {
  return (
    <section className="panel narrow">
      <Lock size={22} />
      <h1>Connect Supabase to start Automoteev</h1>
      <p>Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to `apps/web/.env` or your Vercel project.</p>
    </section>
  );
}

function AuthPanel() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const result = await supabase.auth.signInWithPassword({ email, password });
        if (result.error) setError(result.error.message);
      } else {
        const result = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin }
        });
        if (result.error) setError(result.error.message);
        else if (!result.data.session)
          setInfo("Check your email and click the confirmation link to finish creating your account.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-grid">
      <div className="intro">
        <div className="brand">Automoteev</div>
        <h1>Save money on your car. Without lifting a finger.</h1>
        <p>
          Automoteev is the AI agent that watches your insurance, loan, and service costs,
          finds savings, requests quotes from real providers, and acts on your behalf. You
          only see the wins worth taking.
        </p>
        <div className="trust-row"><ShieldCheck size={18} /> Nothing gets sent to a provider without your approval.</div>
      </div>
      <form className="panel auth-card" onSubmit={submit}>
        <h2>{mode === "signin" ? "Sign in" : "Create account"}</h2>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required /></label>
        <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={8} required /></label>
        {error && <div className="error">{error}</div>}
        {info && <div className="notice">{info}</div>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setInfo(null); }}
        >
          {mode === "signin" ? "Create an account" : "Already have an account"}
        </button>
      </form>
    </section>
  );
}

// ============================================================
// Product (signed in)
// ============================================================
function Product({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>("status");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [autonomy, setAutonomy] = useState<AutonomyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightTaskId, setHighlightTaskId] = useState<string | null>(null);
  const [openForm, setOpenForm] = useState<FormId | null>(null);
  const [actBusyKey, setActBusyKey] = useState<string | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const vehicleResponse = await api<{ vehicles: Vehicle[] }>("/api/vehicles");
      setVehicles(vehicleResponse.vehicles);
      const nextId = selectedId ?? vehicleResponse.vehicles[0]?.id ?? null;
      setSelectedId(nextId);
      if (nextId) {
        const [dash, taskResponse, providerResponse, autonomyResponse] = await Promise.all([
          api<Dashboard>(`/api/vehicles/${nextId}/dashboard`),
          api<{ tasks: Task[] }>("/api/tasks"),
          api<{ providers: Provider[] }>("/api/providers"),
          api<AutonomyStatus>("/api/autonomy/status")
        ]);
        setDashboard(dash);
        setTasks(taskResponse.tasks);
        setProviders(providerResponse.providers);
        setAutonomy(autonomyResponse);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
      setInitialLoaded(true);
    }
  }

  /**
   * Two-tap flow (Option A): Tap a recommendation → backend creates a
   * needs_user_approval task → we navigate to Tasks tab → user taps Approve.
   * For "completeness" gaps, we open an inline form modal instead.
   * For "run_recall_check" we run it inline and refresh.
   */
  async function actOnInsight(insight: Insight) {
    if (!selectedId) return;
    setActBusyKey(insight.key);
    try {
      const result = await api<{
        action: string;
        task?: Task;
        navigate_to?: string;
        form_id?: string;
        recall_status?: string;
      }>("/api/insights/act", {
        method: "POST",
        body: JSON.stringify({ insight_key: insight.key, vehicle_id: selectedId })
      });

      if (result.action === "task_created" && result.task) {
        setHighlightTaskId(result.task.id);
        setTab("tasks");
        await refresh();
      } else if (result.action === "open_form" && result.form_id) {
        setOpenForm(result.form_id as FormId);
      } else if (result.action === "recall_check_run") {
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not act on recommendation.");
    } finally {
      setActBusyKey(null);
    }
  }

  useEffect(() => {
    void refresh();
    // poll dashboard every 30s so background recall lookup / value refresh shows up
    const id = setInterval(() => {
      if (selectedId) {
        api<Dashboard>(`/api/vehicles/${selectedId}/dashboard`)
          .then(setDashboard)
          .catch(() => undefined);
      }
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Don't decide between Onboarding vs Status until the first fetch completes —
  // otherwise we briefly render Onboarding while the API call is in flight.
  if (!initialLoaded) {
    return <Shell><div className="panel"><Loader2 size={16} className="spinner" /> Loading your vehicle…</div></Shell>;
  }
  if (!vehicles.length) {
    return <Shell><Onboarding onDone={refresh} email={session.user.email ?? ""} /></Shell>;
  }

  return (
    <Shell>
      <header className="topbar">
        <div>
          <div className="brand">Automoteev</div>
          <div className="muted small">Your AI vehicle agent</div>
        </div>
        <nav className="tabs desktop-only" aria-label="Main">
          {(["status", "tasks", "command", "history", "settings"] as Tab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </nav>
      </header>

      {error && <div className="notice error-notice">{error}</div>}
      {busy && <div className="thin-status"><Loader2 size={16} className="spinner" /> Syncing vehicle data…</div>}

      {openForm && selectedId && (
        <InlineFormModal
          formId={openForm}
          vehicleId={selectedId}
          onClose={() => setOpenForm(null)}
          onSaved={() => {
            setOpenForm(null);
            void refresh();
          }}
        />
      )}

      {tab === "status" && dashboard && selectedId && (
        <Status
          dashboard={dashboard}
          vehicleId={selectedId}
          onRefresh={refresh}
          onActOnInsight={actOnInsight}
          actBusyKey={actBusyKey}
        />
      )}
      {tab === "tasks" && dashboard && (
        <TaskCenter
          dashboard={dashboard}
          tasks={tasks}
          providers={providers}
          autonomy={autonomy}
          highlightTaskId={highlightTaskId}
          onActOnInsight={actOnInsight}
          actBusyKey={actBusyKey}
          onRefresh={refresh}
        />
      )}
      {tab === "command" && selectedId && <Command vehicleId={selectedId} onCreated={refresh} />}
      {tab === "history" && <History tasks={tasks} />}
      {tab === "settings" && <Settings autonomy={autonomy} />}

      {/* Mobile bottom nav */}
      <nav className="bottom-nav mobile-only" aria-label="Main">
        {(["status", "tasks", "command", "history", "settings"] as Tab[]).map((item) => (
          <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
            <BottomNavIcon tab={item} />
            <span>{item}</span>
          </button>
        ))}
      </nav>
    </Shell>
  );
}

function BottomNavIcon({ tab }: { tab: Tab }) {
  const sz = 18;
  if (tab === "status") return <CheckCircle2 size={sz} />;
  if (tab === "tasks") return <Wrench size={sz} />;
  if (tab === "command") return <Send size={sz} />;
  if (tab === "history") return <Clock3 size={sz} />;
  return <Lock size={sz} />;
}

// ============================================================
// Onboarding (minimal, document upload comes after)
// ============================================================
function Onboarding({ onDone, email }: { onDone: () => void; email: string }) {
  const [form, setForm] = useState({
    full_name: "",
    email,
    zip_code: "",
    vin: "",
    mileage: "",
    ownership_type: "owned"
  });
  const [consents, setConsents] = useState({
    reserve_obd: true,
    accepted_tos: true,
    accepted_privacy: true,
    accepted_autonomy_consent: true
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!consents.accepted_tos || !consents.accepted_privacy || !consents.accepted_autonomy_consent) {
      setError("Please accept all three agreements to continue.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ ...normalizeForm(form), ...consents })
      });
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Onboarding failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel onboarding" onSubmit={submit}>
      <h1>Set up your vehicle</h1>
      <p className="muted">
        Just the basics for now. After this, you can snap a photo of your insurance dec page
        or loan statement and Automoteev will fill in the details automatically.
      </p>

      <h3 className="section-head">Who you are</h3>
      <div className="form-grid">
        <Field label="Name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} required />
        <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />
        <Field label="ZIP code" value={form.zip_code} onChange={(v) => setForm({ ...form, zip_code: v })} required />
      </div>

      <h3 className="section-head">Your vehicle</h3>
      <div className="form-grid">
        <Field label="VIN" value={form.vin} onChange={(v) => setForm({ ...form, vin: v.toUpperCase() })} required />
        <Field label="Mileage" value={form.mileage} onChange={(v) => setForm({ ...form, mileage: v })} required />
        <label>Ownership type
          <select value={form.ownership_type} onChange={(e) => setForm({ ...form, ownership_type: e.target.value })}>
            <option value="owned">Owned</option>
            <option value="financed">Financed</option>
            <option value="leased">Leased</option>
          </select>
        </label>
      </div>

      <div className="consent-block">
        <label className="checkbox-row">
          <input type="checkbox" checked={consents.reserve_obd} onChange={(e) => setConsents({ ...consents, reserve_obd: e.target.checked })} />
          <span>Reserve a free Automoteev OBD dongle (ships when available — no charge).</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={consents.accepted_tos} onChange={(e) => setConsents({ ...consents, accepted_tos: e.target.checked })} required />
          <span>I accept the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>.</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={consents.accepted_privacy} onChange={(e) => setConsents({ ...consents, accepted_privacy: e.target.checked })} required />
          <span>I accept the <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.</span>
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={consents.accepted_autonomy_consent} onChange={(e) => setConsents({ ...consents, accepted_autonomy_consent: e.target.checked })} required />
          <span>
            I authorize Automoteev to contact providers on my behalf. Levels progress as I approve actions:
            Level 1 (Assisted) asks every time, Level 2 (Trusted) allows repeats, Level 3 (Autonomous) acts
            on approved categories. I can revoke autonomy at any time from Settings.
          </span>
        </label>
      </div>

      {error && <div className="error">{error}</div>}
      <button className="primary" type="submit" disabled={busy}>
        <Plus size={18} /> {busy ? "Creating profile…" : "Create vehicle profile"}
      </button>
    </form>
  );
}

// ============================================================
// STATUS TAB
// ============================================================
function Status({
  dashboard,
  vehicleId,
  onRefresh,
  onActOnInsight,
  actBusyKey
}: {
  dashboard: Dashboard;
  vehicleId: string;
  onRefresh: () => void;
  onActOnInsight: (insight: Insight) => void;
  actBusyKey: string | null;
}) {
  const status = dashboard.vehicle.overall_status;
  const statusColor = status === "all_good" ? "green" : status === "action_needed" ? "red" : "yellow";
  const statusText = status === "all_good" ? "All good" : status === "action_needed" ? "Action needed" : "Action recommended";
  const otherInsights = dashboard.insights.filter((i) => i.key !== dashboard.recommended_action?.key);
  const totalSavings = dashboard.total_estimated_annual_savings_usd;

  return (
    <section className="status-layout">
      <div className={`status-hero status-${statusColor}`}>
        <div className="status-head">
          <div>
            <p className="muted small">Your vehicle</p>
            <h1 className="vehicle-title">{vehicleName(dashboard.vehicle)}</h1>
            <p className="muted small">VIN {dashboard.vehicle.vin} · {dashboard.vehicle.mileage.toLocaleString()} mi</p>
          </div>
          <span className={`status-pill status-pill-${statusColor}`}>
            {status === "all_good" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {statusText}
          </span>
        </div>

        {totalSavings > 0 && (
          <div className="savings-banner">
            <TrendingUp size={20} />
            <div>
              <strong>Automoteev sees ~${totalSavings.toLocaleString()}/yr in potential savings</strong>
              <p className="small muted">Tap a recommendation to let Automoteev pursue it.</p>
            </div>
          </div>
        )}

        {dashboard.recommended_action && (
          <RecommendedAction
            insight={dashboard.recommended_action}
            onAct={() => onActOnInsight(dashboard.recommended_action!)}
            busy={actBusyKey === dashboard.recommended_action.key}
          />
        )}

        <div className="metric-grid">
          <Metric label="Monthly cost" value={money(dashboard.cost_profile?.total_monthly_cost_cents)} />
          <Metric
            label="Market value (est.)"
            value={moneyRange(dashboard.valuation?.market_value_low_cents, dashboard.valuation?.market_value_high_cents)}
          />
          <Metric
            label="Dealer offer (est.)"
            value={moneyRange(dashboard.valuation?.dealer_value_low_cents, dashboard.valuation?.dealer_value_high_cents)}
          />
          <Metric label="Loan/lease balance" value={money(dashboard.loan_lease?.balance_cents)} />
          <Metric label="Insurance" value={dashboard.insurance?.carrier_name ?? "Missing"} />
          <Metric
            label="Recall status"
            value={
              dashboard.vehicle.recall_status === "open"
                ? `${dashboard.open_recalls.length} open`
                : dashboard.vehicle.recall_status === "clear"
                ? "Clear"
                : "Checking…"
            }
          />
        </div>

        {dashboard.open_recalls.length > 0 && <RecallList recalls={dashboard.open_recalls} />}
        {dashboard.maintenance_items.length > 0 && <MaintenanceList items={dashboard.maintenance_items} />}

        <DocumentDropZone vehicleId={vehicleId} onComplete={onRefresh} />
      </div>

      <aside className="side-panel">
        {otherInsights.length > 0 && (
          <ImprovementsPanel
            insights={otherInsights}
            onAct={onActOnInsight}
            actBusyKey={actBusyKey}
          />
        )}
        <button className="primary refresh-button" onClick={onRefresh}>
          <Clock3 size={18} /> Refresh vehicle status
        </button>
        <div className="privacy-note">
          <Lock size={16} /> Automoteev logs every action and never contacts providers without approval.
        </div>
      </aside>
    </section>
  );
}

function RecommendedAction({
  insight,
  onAct,
  busy
}: {
  insight: Insight;
  onAct: () => void;
  busy: boolean;
}) {
  const tone =
    insight.severity === "urgent"
      ? "rec-urgent"
      : insight.severity === "recommended"
      ? "rec-recommended"
      : "rec-info";
  return (
    <button className={`recommended-action ${tone}`} onClick={onAct} disabled={busy}>
      <div className="rec-icon">
        {busy ? <Loader2 size={20} className="spinner" /> :
          insight.severity === "urgent" ? <AlertTriangle size={20} /> :
          insight.category === "insurance" || insight.category === "lending" ? <DollarSign size={20} /> :
          <Sparkles size={20} />}
      </div>
      <div className="rec-body">
        <div className="rec-title">{insight.title}</div>
        <div className="rec-text">{insight.body}</div>
        <div className="rec-cta">{busy ? "Working…" : insight.cta_label} <ChevronRight size={16} /></div>
      </div>
    </button>
  );
}

function ImprovementsPanel({
  insights,
  onAct,
  actBusyKey
}: {
  insights: Insight[];
  onAct: (i: Insight) => void;
  actBusyKey: string | null;
}) {
  return (
    <div className="panel improvements">
      <div className="improvements-head">
        <Info size={18} />
        <strong>Automoteev found {insights.length} thing{insights.length === 1 ? "" : "s"} to improve</strong>
      </div>
      <ul className="improvements-list">
        {insights.map((i) => (
          <li key={i.key}>
            <button onClick={() => onAct(i)} disabled={actBusyKey === i.key} className={`imp-item imp-${i.severity}`}>
              <span className="imp-title">{i.title}</span>
              {i.estimated_savings_usd_per_year ? (
                <span className="imp-savings">~${i.estimated_savings_usd_per_year}/yr</span>
              ) : null}
              {actBusyKey === i.key ? <Loader2 size={14} className="spinner imp-chev" /> : <ChevronRight size={14} className="imp-chev" />}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecallList({ recalls }: { recalls: RecallRecord[] }) {
  return (
    <div className="sub-panel">
      <h3>Open recalls ({recalls.length})</h3>
      <p className="small muted">Recall repairs are free at any authorized dealer. Tap any item to see what's affected.</p>
      {recalls.map((r) => (
        <details className="recall-item" key={r.id}>
          <summary>
            <AlertTriangle size={18} className="recall-icon" />
            <div className="recall-summary-text">
              <strong>{r.component ?? "Recall campaign"}</strong>
              <span className="muted small">Campaign #{r.nhtsa_campaign_id}</span>
            </div>
            <ChevronRight size={18} className="recall-chev" />
          </summary>
          <div className="recall-details">
            {r.summary && (
              <p className="small"><strong>What's affected:</strong> {r.summary}</p>
            )}
            {r.remedy && (
              <p className="small"><strong>Remedy:</strong> {r.remedy}</p>
            )}
            {r.reported_at && (
              <p className="small muted">
                Reported {new Date(r.reported_at).toLocaleDateString()}
              </p>
            )}
            <a
              className="small recall-nhtsa-link"
              href={`https://www.nhtsa.gov/recalls?nhtsaId=${r.nhtsa_campaign_id}`}
              target="_blank"
              rel="noreferrer"
            >
              View on NHTSA ↗
            </a>
          </div>
        </details>
      ))}
    </div>
  );
}

function MaintenanceList({ items }: { items: MaintenanceItem[] }) {
  const upcoming = items.filter((i) => ["upcoming", "due", "overdue"].includes(i.status)).slice(0, 4);
  if (!upcoming.length) return null;
  return (
    <div className="sub-panel">
      <h3>Upcoming maintenance</h3>
      <ul className="maint-list">
        {upcoming.map((item) => (
          <li key={item.id}>
            <span className={`chip ${item.status}`}>{item.status}</span>
            <span className="maint-name">{item.item_type.replaceAll("_", " ")}</span>
            <span className="muted small">
              {item.due_mileage ? `${item.due_mileage.toLocaleString()} mi` : ""}
              {item.estimated_cost_cents ? ` · ~${money(item.estimated_cost_cents)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================
// Document Drop Zone (image capture for dec page / loan statement)
// ============================================================
function DocumentDropZone({ vehicleId, onComplete }: { vehicleId: string; onComplete: () => void }) {
  const [uploading, setUploading] = useState<"insurance_dec_page" | "loan_statement" | null>(null);
  const [pending, setPending] = useState<UploadedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insuranceInputRef = useRef<HTMLInputElement>(null);
  const loanInputRef = useRef<HTMLInputElement>(null);

  async function uploadAndExtract(file: File, kind: "insurance_dec_page" | "loan_statement") {
    setUploading(kind);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("document_kind", kind);
      formData.append("vehicle_id", vehicleId);

      const apiUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new Error("Not signed in");
      const res = await fetch(`${apiUrl}/api/documents`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Upload failed");
      }
      const result = (await res.json()) as { document: UploadedDocument };
      setPending(result.document);

      // Poll for extraction completion
      const docId = result.document.id;
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const status = await api<{ document: UploadedDocument }>(`/api/documents/${docId}`);
          if (status.document.extraction_status === "completed") {
            clearInterval(poll);
            setPending(status.document);
          } else if (status.document.extraction_status === "failed") {
            clearInterval(poll);
            setPending(status.document);
            setError(status.document.extraction_error ?? "Extraction failed");
          }
          if (attempts > 30) clearInterval(poll);
        } catch {
          // ignore transient
        }
      }, 2_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setUploading(null);
    }
  }

  async function applyExtracted() {
    if (!pending) return;
    try {
      await api(`/api/documents/${pending.id}/apply`, {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicleId })
      });
      setPending(null);
      setUploading(null);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    }
  }

  return (
    <div className="sub-panel">
      <h3>Snap a photo, Automoteev fills it in</h3>
      <p className="small muted">No typing. Take a picture of your dec page or loan statement and Automoteev pulls out the details.</p>

      <div className="upload-cards">
        <button
          type="button"
          className="upload-card"
          onClick={() => insuranceInputRef.current?.click()}
          disabled={uploading !== null}
        >
          {uploading === "insurance_dec_page" ? <Loader2 size={26} className="spinner" /> : <Camera size={26} />}
          <strong>Insurance dec page</strong>
          <span className="small muted">Carrier, premium, coverage, renewal</span>
        </button>
        <input
          ref={insuranceInputRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadAndExtract(f, "insurance_dec_page");
          }}
        />

        <button
          type="button"
          className="upload-card"
          onClick={() => loanInputRef.current?.click()}
          disabled={uploading !== null}
        >
          {uploading === "loan_statement" ? <Loader2 size={26} className="spinner" /> : <FileImage size={26} />}
          <strong>Loan statement</strong>
          <span className="small muted">Lender, balance, APR, payment</span>
        </button>
        <input
          ref={loanInputRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadAndExtract(f, "loan_statement");
          }}
        />
      </div>

      {pending && pending.extraction_status === "processing" && (
        <div className="notice"><Loader2 size={16} className="spinner" /> Reading your document…</div>
      )}

      {pending && pending.extraction_status === "completed" && pending.extracted_data && (
        <div className="extraction-preview">
          <strong>Found:</strong>
          <ul className="small">
            {Object.entries(pending.extracted_data)
              .filter(([_, v]) => v !== null && v !== undefined && v !== "")
              .slice(0, 8)
              .map(([k, v]) => (
                <li key={k}><span className="muted">{k.replaceAll("_", " ")}:</span> {String(v)}</li>
              ))}
          </ul>
          <div className="button-row">
            <button className="primary" type="button" onClick={applyExtracted}>
              <CheckCircle2 size={16} /> Apply to my profile
            </button>
            <button className="ghost" type="button" onClick={() => { setPending(null); setUploading(null); }}>
              Discard
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}

// ============================================================
// Inline Form Modal (for "completeness" insights)
// ============================================================
function InlineFormModal({
  formId,
  vehicleId,
  onClose,
  onSaved
}: {
  formId: FormId;
  vehicleId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Insurance form
  const [insForm, setInsForm] = useState({
    carrier_name: "",
    premium_cents: "",
    renewal_date: "",
    coverage_type: ""
  });

  // Loan form
  const [loanForm, setLoanForm] = useState({
    lender_name: "",
    balance_cents: "",
    monthly_payment_cents: "",
    apr_percent: "",
    term_months: ""
  });

  // Fuel form
  const [fuelForm, setFuelForm] = useState({
    entry_date: new Date().toISOString().slice(0, 10),
    total_cents: "",
    gallons: ""
  });

  // Preferred shop form
  const [shopForm, setShopForm] = useState({
    name: "",
    location: "",
    phone: "",
    email: ""
  });

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (formId === "insurance") {
        const body: Record<string, unknown> = {
          carrier_name: insForm.carrier_name || null,
          renewal_date: insForm.renewal_date || null,
          coverage_type: insForm.coverage_type || null
        };
        if (insForm.premium_cents) body.premium_cents = Math.round(Number(insForm.premium_cents) * 100);
        await api(`/api/insurance/${vehicleId}`, { method: "PUT", body: JSON.stringify(body) });
      } else if (formId === "loan") {
        const body: Record<string, unknown> = {
          lender_name: loanForm.lender_name || null
        };
        if (loanForm.balance_cents) body.balance_cents = Math.round(Number(loanForm.balance_cents) * 100);
        if (loanForm.monthly_payment_cents) body.monthly_payment_cents = Math.round(Number(loanForm.monthly_payment_cents) * 100);
        if (loanForm.apr_percent) body.apr_bps = Math.round(Number(loanForm.apr_percent) * 100);
        if (loanForm.term_months) body.term_months = Number(loanForm.term_months);
        await api(`/api/loan-lease/${vehicleId}`, { method: "PUT", body: JSON.stringify(body) });
      } else if (formId === "fuel") {
        const body = {
          entry_date: fuelForm.entry_date,
          total_cents: Math.round(Number(fuelForm.total_cents || 0) * 100),
          gallons: fuelForm.gallons ? Number(fuelForm.gallons) : null
        };
        await api(`/api/vehicles/${vehicleId}/fuel`, { method: "POST", body: JSON.stringify(body) });
      } else if (formId === "preferred_shop") {
        await api("/api/providers", {
          method: "POST",
          body: JSON.stringify({
            name: shopForm.name,
            location: shopForm.location || null,
            phone: shopForm.phone || null,
            email: shopForm.email || null,
            provider_type: "service_shop",
            is_preferred: true
          })
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const titles = {
    insurance: "Add your insurance",
    loan: "Add your loan",
    fuel: "Log fuel cost",
    preferred_shop: "Pick a preferred shop"
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{titles[formId]}</h2>
          <button className="ghost icon-button" onClick={onClose}><X size={18} /></button>
        </div>

        {formId === "insurance" && (
          <div className="form-grid">
            <Field label="Carrier" value={insForm.carrier_name} onChange={(v) => setInsForm({ ...insForm, carrier_name: v })} />
            <Field label="Monthly premium" value={insForm.premium_cents} onChange={(v) => setInsForm({ ...insForm, premium_cents: v })} money />
            <Field label="Renewal date" value={insForm.renewal_date} onChange={(v) => setInsForm({ ...insForm, renewal_date: v })} type="date" />
            <label>Coverage
              <select value={insForm.coverage_type} onChange={(e) => setInsForm({ ...insForm, coverage_type: e.target.value })}>
                <option value="">—</option>
                <option value="liability">Liability only</option>
                <option value="full">Full coverage</option>
                <option value="comprehensive">Comprehensive</option>
              </select>
            </label>
          </div>
        )}

        {formId === "loan" && (
          <div className="form-grid">
            <Field label="Lender" value={loanForm.lender_name} onChange={(v) => setLoanForm({ ...loanForm, lender_name: v })} />
            <Field label="Current balance" value={loanForm.balance_cents} onChange={(v) => setLoanForm({ ...loanForm, balance_cents: v })} money />
            <Field label="Monthly payment" value={loanForm.monthly_payment_cents} onChange={(v) => setLoanForm({ ...loanForm, monthly_payment_cents: v })} money />
            <Field label="APR (%)" value={loanForm.apr_percent} onChange={(v) => setLoanForm({ ...loanForm, apr_percent: v })} decimal placeholder="e.g. 6.49" />
            <Field label="Term (months)" value={loanForm.term_months} onChange={(v) => setLoanForm({ ...loanForm, term_months: v })} />
          </div>
        )}

        {formId === "fuel" && (
          <div className="form-grid">
            <Field label="Date" value={fuelForm.entry_date} onChange={(v) => setFuelForm({ ...fuelForm, entry_date: v })} type="date" required />
            <Field label="Total spent" value={fuelForm.total_cents} onChange={(v) => setFuelForm({ ...fuelForm, total_cents: v })} money required />
            <Field label="Gallons" value={fuelForm.gallons} onChange={(v) => setFuelForm({ ...fuelForm, gallons: v })} decimal />
          </div>
        )}

        {formId === "preferred_shop" && (
          <div className="form-grid">
            <Field label="Shop name" value={shopForm.name} onChange={(v) => setShopForm({ ...shopForm, name: v })} required />
            <Field label="Location" value={shopForm.location} onChange={(v) => setShopForm({ ...shopForm, location: v })} />
            <Field label="Phone" value={shopForm.phone} onChange={(v) => setShopForm({ ...shopForm, phone: v })} />
            <Field label="Email" value={shopForm.email} onChange={(v) => setShopForm({ ...shopForm, email: v })} type="email" />
          </div>
        )}

        {error && <div className="error">{error}</div>}
        <div className="button-row">
          <button className="primary" onClick={submit} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TASKS TAB
// ============================================================
function TaskCenter({
  dashboard,
  tasks,
  providers,
  autonomy,
  highlightTaskId,
  onActOnInsight,
  actBusyKey,
  onRefresh
}: {
  dashboard: Dashboard;
  tasks: Task[];
  providers: Provider[];
  autonomy: AutonomyStatus | null;
  highlightTaskId: string | null;
  onActOnInsight: (i: Insight) => void;
  actBusyKey: string | null;
  onRefresh: () => void;
}) {
  const groups = useMemo(
    () => ({
      active: tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status))
    }),
    [tasks]
  );

  async function approve(task: Task, approved: boolean) {
    await api(`/api/tasks/${task.id}/approval`, { method: "POST", body: JSON.stringify({ approved }) });
    onRefresh();
  }

  return (
    <section className="task-page">
      {autonomy && <AutonomyStepper autonomy={autonomy} />}

      <div className="panel">
        <h2>What Automoteev recommends</h2>
        {dashboard.insights.length === 0 ? (
          <p className="muted">Nothing to do — your vehicle is fully covered.</p>
        ) : (
          <div className="recs-grid">
            {dashboard.insights.map((insight) => (
              <RecommendationCard
                key={insight.key}
                insight={insight}
                onAct={() => onActOnInsight(insight)}
                busy={actBusyKey === insight.key}
              />
            ))}
          </div>
        )}
      </div>

      <ProviderOutreach providers={providers} tasks={groups.active} autonomy={autonomy} onRefresh={onRefresh} />

      <div className="panel">
        <h2>Active tasks</h2>
        {groups.active.length === 0 ? (
          <p className="muted">No active tasks. Tap a recommendation above to get started.</p>
        ) : (
          groups.active.map((task) => (
            <article
              className={`task-card ${task.id === highlightTaskId ? "highlight" : ""}`}
              key={task.id}
            >
              <div className="task-title"><Wrench size={17} /> {task.title}</div>
              <div className={`status-chip status-${task.status}`}>{task.status.replaceAll("_", " ")}</div>
              {task.approval_summary && <p>{task.approval_summary}</p>}
              {task.shared_fields?.length ? (
                <p className="muted small">Shared after approval: {task.shared_fields.join(", ")}</p>
              ) : null}
              {task.status === "needs_user_approval" && (
                <div className="button-row">
                  <button className="primary" onClick={() => approve(task, true)}>Approve</button>
                  <button className="ghost" onClick={() => approve(task, false)}>Cancel</button>
                </div>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function RecommendationCard({
  insight,
  onAct,
  busy
}: {
  insight: Insight;
  onAct: () => void;
  busy: boolean;
}) {
  const tone =
    insight.severity === "urgent" ? "rec-urgent" : insight.severity === "recommended" ? "rec-recommended" : "rec-info";
  return (
    <button className={`rec-card ${tone}`} onClick={onAct} disabled={busy} type="button">
      <div className="rec-card-head">
        {busy ? <Loader2 size={18} className="spinner" /> :
          insight.severity === "urgent" ? <AlertTriangle size={18} /> :
          insight.category === "insurance" || insight.category === "lending" ? <DollarSign size={18} /> :
          <Sparkles size={18} />}
        <strong>{insight.title}</strong>
      </div>
      <p className="small">{insight.body}</p>
      {insight.estimated_savings_usd_per_year ? (
        <p className="small savings-hint">Estimated savings: ~${insight.estimated_savings_usd_per_year}/year</p>
      ) : null}
      <div className="rec-cta">{busy ? "Working…" : insight.cta_label} <ChevronRight size={14} /></div>
    </button>
  );
}

function AutonomyStepper({ autonomy }: { autonomy: AutonomyStatus }) {
  const remaining = Math.max(0, autonomy.threshold - autonomy.approved_email_count);
  return (
    <div className="panel autonomy-stepper">
      <div className="stepper-head">
        <ShieldCheck size={18} />
        <strong>Autonomy Level {autonomy.level}: {autonomy.level_label}</strong>
      </div>
      <div className="stepper-progress">
        {[1, 2, 3].map((step) => (
          <div key={step} className={`step ${autonomy.level >= step ? "active" : ""} ${autonomy.level === step ? "current" : ""}`}>
            <div className="step-dot">{step}</div>
            <div className="step-label">
              {step === 1 ? "Assisted" : step === 2 ? "Trusted" : "Autonomous"}
            </div>
          </div>
        ))}
      </div>
      <p className="small muted">
        {autonomy.level === 3
          ? "Automoteev acts on approved categories without asking each time."
          : autonomy.level === 2
          ? "Repeats allowed for tasks you've already approved."
          : `Asks before every outbound action. ${remaining} more approval${remaining === 1 ? "" : "s"} until Trusted, ${autonomy.threshold - autonomy.approved_email_count} until Autonomous.`}
      </p>
    </div>
  );
}

function ProviderOutreach({
  providers,
  tasks,
  autonomy,
  onRefresh
}: {
  providers: Provider[];
  tasks: Task[];
  autonomy: AutonomyStatus | null;
  onRefresh: () => void;
}) {
  const approvedTasks = tasks.filter((task) => task.status === "approved");
  const [form, setForm] = useState({ name: "", email: "", phone: "", provider_type: "service_shop", location: "" });
  const [selectedTask, setSelectedTask] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function saveProvider(event: React.FormEvent) {
    event.preventDefault();
    await api("/api/providers", { method: "POST", body: JSON.stringify(normalizeForm(form)) });
    setForm({ name: "", email: "", phone: "", provider_type: "service_shop", location: "" });
    onRefresh();
  }

  async function sendEmail() {
    setMessage(null);
    const gate = autonomy?.requires_approval_for_next_send;
    const confirmed =
      !gate ||
      window.confirm("This email will be sent as you, from your Automoteev alias. Phone is not disclosed. Proceed?");
    if (!confirmed) return;
    try {
      await api(`/api/tasks/${selectedTask}/emails`, {
        method: "POST",
        body: JSON.stringify({ provider_id: selectedProvider, notes })
      });
      setNotes("");
      onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Email outreach failed.");
    }
  }

  if (approvedTasks.length === 0 && providers.length === 0) {
    // Hide outreach panel until there's a reason to show it
    return null;
  }

  return (
    <div className="panel outreach-panel">
      <details>
        <summary><h2 style={{ display: "inline" }}>Provider outreach</h2></summary>
        <p className="muted small">Add a provider manually, or let Automoteev find one. Email outreach requires Pro and an approved task.</p>
        <form className="provider-form" onSubmit={saveProvider}>
          <Field label="Provider name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <Field label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} type="email" />
          <Field label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          <label>Type
            <select value={form.provider_type} onChange={(e) => setForm({ ...form, provider_type: e.target.value })}>
              <option value="service_shop">Service shop</option>
              <option value="dealership_service">Dealership service</option>
              <option value="oil_change">Oil change</option>
              <option value="tire_shop">Tire shop</option>
              <option value="body_shop">Body shop</option>
              <option value="insurance_agent">Insurance agent</option>
              <option value="buying_center">Buying center</option>
            </select>
          </label>
          <Field label="Location" value={form.location} onChange={(v) => setForm({ ...form, location: v })} />
          <button className="secondary" type="submit">Add provider</button>
        </form>
        <div className="provider-form">
          <label>Approved task
            <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)}>
              <option value="">Select task</option>
              {approvedTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
            </select>
          </label>
          <label>Provider
            <select value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)}>
              <option value="">Select provider</option>
              {providers.filter((p) => p.email).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <button className="primary" disabled={!selectedTask || !selectedProvider} onClick={sendEmail} type="button">
            <Mail size={18} /> {autonomy?.requires_approval_for_next_send ? "Approve & send" : "Send email"}
          </button>
        </div>
        {message && <div className="notice">{message}</div>}
      </details>
    </div>
  );
}

// ============================================================
// COMMAND TAB
// ============================================================
function Command({ vehicleId, onCreated }: { vehicleId: string; onCreated: () => void }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setConfirmation(null);
    try {
      await api("/api/tasks/command", {
        method: "POST",
        body: JSON.stringify({ vehicle_id: vehicleId, command })
      });
      setConfirmation(
        `Got it. Automoteev is on it — "${command}". You'll get an approval request before any provider is contacted.`
      );
      setCommand("");
      onCreated();
    } catch (err) {
      setConfirmation(err instanceof Error ? err.message : "Could not create task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel command-panel" onSubmit={submit}>
      <h1>Tell Automoteev what to handle</h1>
      <p className="muted">Type or pick one. Automoteev will plan the work, request your approval where needed, and act on your behalf.</p>
      <div className="quick-commands">
        {[
          "Find cheaper insurance",
          "Book service",
          "Check recalls",
          "Help me sell my car",
          "Get refinance quotes",
          "Get my payoff amount",
          "Plan lease end"
        ].map((item) => (
          <button type="button" className="secondary" key={item} onClick={() => setCommand(item)}>
            {item}
          </button>
        ))}
      </div>
      <label>Command<input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Find cheaper insurance" required /></label>
      <button className="primary" type="submit" disabled={busy || !command.trim()}>
        <Send size={18} /> {busy ? "Handing off…" : "Let Automoteev agent handle this"}
      </button>
      {confirmation && <div className="notice success-notice">{confirmation}</div>}
    </form>
  );
}

// ============================================================
// HISTORY TAB
// ============================================================
function History({ tasks }: { tasks: Task[] }) {
  const closed = tasks.filter((t) => ["completed", "failed", "cancelled"].includes(t.status));
  const grouped = {
    completed: closed.filter((t) => t.status === "completed"),
    cancelled: closed.filter((t) => t.status === "cancelled"),
    failed: closed.filter((t) => t.status === "failed")
  };

  return (
    <section className="history-page">
      <div className="panel">
        <h2>Task history</h2>
        {closed.length === 0 ? (
          <p className="muted">Nothing here yet. Approved and finished tasks will show up here.</p>
        ) : (
          <>
            <HistoryGroup title="Completed" tasks={grouped.completed} />
            <HistoryGroup title="Cancelled" tasks={grouped.cancelled} />
            <HistoryGroup title="Did not complete" tasks={grouped.failed} subtle />
          </>
        )}
      </div>
    </section>
  );
}

function HistoryGroup({ title, tasks, subtle }: { title: string; tasks: Task[]; subtle?: boolean }) {
  if (!tasks.length) return null;
  return (
    <div className={`history-group ${subtle ? "subtle" : ""}`}>
      <h3>{title}</h3>
      <ul className="history-list">
        {tasks.map((t) => (
          <li key={t.id}>
            <span className="history-title">{t.title}</span>
            <span className="muted small">{new Date(t.created_at).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================
// SETTINGS TAB
// ============================================================
function Settings({ autonomy }: { autonomy: AutonomyStatus | null }) {
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);

  useEffect(() => {
    void api<SubscriptionStatus>("/api/subscription/status").then(setSubscription).catch(() => undefined);
  }, []);

  async function checkout(plan: "monthly" | "annual") {
    const result = await api<{ url: string | null; configured: boolean }>("/api/billing/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ plan })
    });
    if (result.url) window.location.assign(result.url);
    else alert("Stripe is not configured yet.");
  }

  const agentEmail = autonomy?.agent_email;

  return (
    <section className="settings-grid">
      <div className="panel">
        <h2>Your plan</h2>
        {subscription?.is_pro ? (
          <>
            <p><strong>Automoteev Pro — active.</strong></p>
            {subscription.subscription && (
              <p className="muted small">
                {subscription.subscription.plan === "pro_annual" ? "Annual plan" : "Monthly plan"}
                {subscription.subscription.current_period_end
                  ? ` · renews ${new Date(subscription.subscription.current_period_end).toLocaleDateString()}`
                  : ""}
              </p>
            )}
          </>
        ) : (
          <>
            <p><strong>Free:</strong> dashboard, recall checks, savings recommendations, valuation, fuel log.</p>
            <p><strong>Pro $9.99/mo or $99/yr:</strong> autonomous agent outreach, multi-vehicle, document upload + AI auto-fill, OBD dongle, SMS channel (coming soon).</p>
            <div className="button-row">
              <button className="primary" onClick={() => checkout("monthly")}>Upgrade — $9.99/mo</button>
              <button className="secondary" onClick={() => checkout("annual")}>Upgrade — $99/yr (save ~17%)</button>
            </div>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Your agent email</h2>
        {agentEmail ? (
          <>
            <p className="mono">{agentEmail}</p>
            <p className="muted small">
              Automoteev sends outbound provider email from this address on your behalf. Provider replies
              route back here automatically and attach to the right task.
            </p>
          </>
        ) : (
          <p className="muted">Alias will be assigned after your first vehicle is created.</p>
        )}

        {autonomy && (
          <>
            <h2 style={{ marginTop: 20 }}>Autonomy</h2>
            <AutonomyStepper autonomy={autonomy} />
          </>
        )}

        <h2 style={{ marginTop: 20 }}>Privacy</h2>
        <p className="small muted">
          Every important action is logged. External sharing requires approval that names who may be
          contacted and which fields may be shared. Phone numbers are never disclosed in outbound email.
        </p>
      </div>
    </section>
  );
}

// ============================================================
// SHARED COMPONENTS
// ============================================================
function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  money: isMoney,
  decimal,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  money?: boolean;
  decimal?: boolean;
  placeholder?: string;
}) {
  const inputType = isMoney || decimal ? "number" : type;
  const step = isMoney || decimal ? "0.01" : undefined;
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        type={inputType}
        step={step}
        min={isMoney || decimal ? 0 : undefined}
        placeholder={placeholder}
        inputMode={isMoney || decimal ? "decimal" : undefined}
      />
    </label>
  );
}

function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1).trimEnd()}…`;
}

function normalizeForm<T extends Record<string, string>>(form: T) {
  return Object.fromEntries(
    Object.entries(form).map(([key, value]) => {
      if (value === "") return [key, null];
      if (key.endsWith("_cents")) return [key, Math.round(Number(value) * 100)];
      if (key === "apr_percent") return ["apr_bps", Math.round(Number(value) * 100)];
      if (["mileage", "term_months"].includes(key)) return [key, Math.round(Number(value))];
      return [key, value];
    })
  );
}
