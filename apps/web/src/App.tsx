import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DollarSign,
  Info,
  Lock,
  Mail,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Wrench
} from "lucide-react";
import { api, money, moneyRange, vehicleName } from "./api";
import { isSupabaseConfigured, supabase } from "./supabase";
import type {
  AutonomyStatus,
  Dashboard,
  Insight,
  InsightSeverity,
  MaintenanceItem,
  OnboardingPrompt,
  Provider,
  RecallRecord,
  SubscriptionStatus,
  Task,
  Vehicle
} from "./types";

type Tab = "status" | "tasks" | "command" | "history" | "settings";

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
  }, []);

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
        <nav className="tabs" aria-label="Main">
          {(["status", "tasks", "command", "history", "settings"] as Tab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </nav>
      </header>

      {error && <div className="notice error-notice">{error}</div>}
      {busy && <div className="thin-status">Syncing vehicle data…</div>}

      {tab === "status" && dashboard && (
        <Status dashboard={dashboard} onRefresh={refresh} onJump={(t) => setTab(t)} />
      )}
      {tab === "tasks" && dashboard && (
        <TaskCenter
          dashboard={dashboard}
          tasks={tasks}
          providers={providers}
          autonomy={autonomy}
          onRefresh={refresh}
        />
      )}
      {tab === "command" && selectedId && <Command vehicleId={selectedId} onCreated={refresh} />}
      {tab === "history" && <History tasks={tasks} />}
      {tab === "settings" && <Settings autonomy={autonomy} />}
    </Shell>
  );
}

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

function Onboarding({ onDone, email }: { onDone: () => void; email: string }) {
  const [form, setForm] = useState({
    full_name: "",
    email,
    zip_code: "",
    vin: "",
    mileage: "",
    ownership_type: "owned",
    monthly_payment_cents: "",
    apr_percent: "",
    lender_name: "",
    loan_lease_balance_cents: "",
    term_months: "",
    lease_maturity_date: "",
    insurance_carrier: "",
    insurance_premium_cents: "",
    insurance_renewal_date: ""
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
        VIN, mileage, name, and email are required. Everything else is optional — the more
        you share, the more savings Automoteev can find.
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

      <h3 className="section-head">Loan or lease <span className="muted">(optional)</span></h3>
      <div className="form-grid">
        <Field label="Lender" value={form.lender_name} onChange={(v) => setForm({ ...form, lender_name: v })} />
        <Field label="Monthly payment" value={form.monthly_payment_cents} onChange={(v) => setForm({ ...form, monthly_payment_cents: v })} money />
        <Field label="Current balance" value={form.loan_lease_balance_cents} onChange={(v) => setForm({ ...form, loan_lease_balance_cents: v })} money />
        <Field label="APR (%)" value={form.apr_percent} onChange={(v) => setForm({ ...form, apr_percent: v })} decimal placeholder="e.g. 6.49" />
        <Field label="Term (months)" value={form.term_months} onChange={(v) => setForm({ ...form, term_months: v })} />
        <Field label="Lease maturity date" value={form.lease_maturity_date} onChange={(v) => setForm({ ...form, lease_maturity_date: v })} type="date" />
      </div>

      <h3 className="section-head">Insurance <span className="muted">(optional)</span></h3>
      <div className="form-grid">
        <Field label="Carrier" value={form.insurance_carrier} onChange={(v) => setForm({ ...form, insurance_carrier: v })} />
        <Field label="Monthly premium" value={form.insurance_premium_cents} onChange={(v) => setForm({ ...form, insurance_premium_cents: v })} money />
        <Field label="Renewal date" value={form.insurance_renewal_date} onChange={(v) => setForm({ ...form, insurance_renewal_date: v })} type="date" />
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
            I authorize Automoteev to contact providers on my behalf. The first 3 outbound emails
            require my approval; after that, Automoteev may send autonomously for tasks I have
            approved. I can revoke autonomy at any time from Settings.
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
// STATUS TAB — hero, recommended action, vehicle facts
// ============================================================
function Status({
  dashboard,
  onRefresh,
  onJump
}: {
  dashboard: Dashboard;
  onRefresh: () => void;
  onJump: (t: Tab) => void;
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
            <h1>{vehicleName(dashboard.vehicle)}</h1>
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
              <p className="small muted">Based on the recommendations below. Approve any to let Automoteev pursue them.</p>
            </div>
          </div>
        )}

        {dashboard.recommended_action && (
          <RecommendedAction
            insight={dashboard.recommended_action}
            onTake={() => onJump("tasks")}
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

        {dashboard.maintenance_items.length > 0 && (
          <MaintenanceList items={dashboard.maintenance_items} />
        )}
      </div>

      <aside className="side-panel">
        {otherInsights.length > 0 && (
          <ImprovementsPanel insights={otherInsights} onJump={() => onJump("tasks")} />
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

function RecommendedAction({ insight, onTake }: { insight: Insight; onTake: () => void }) {
  const tone =
    insight.severity === "urgent"
      ? "rec-urgent"
      : insight.severity === "recommended"
      ? "rec-recommended"
      : "rec-info";
  return (
    <button className={`recommended-action ${tone}`} onClick={onTake}>
      <div className="rec-icon">
        {insight.severity === "urgent" ? <AlertTriangle size={20} /> : insight.category === "savings" ? <DollarSign size={20} /> : <Sparkles size={20} />}
      </div>
      <div className="rec-body">
        <div className="rec-title">{insight.title}</div>
        <div className="rec-text">{insight.body}</div>
        <div className="rec-cta">{insight.cta_label} <ChevronRight size={16} /></div>
      </div>
    </button>
  );
}

function ImprovementsPanel({ insights, onJump }: { insights: Insight[]; onJump: () => void }) {
  return (
    <div className="panel improvements">
      <div className="improvements-head">
        <Info size={18} />
        <strong>Automoteev found {insights.length} thing{insights.length === 1 ? "" : "s"} to improve</strong>
      </div>
      <ul className="improvements-list">
        {insights.map((i) => (
          <li key={i.key}>
            <button onClick={onJump} className={`imp-item imp-${i.severity}`}>
              <span className="imp-title">{i.title}</span>
              {i.estimated_savings_usd_per_year ? (
                <span className="imp-savings">~${i.estimated_savings_usd_per_year}/yr</span>
              ) : null}
              <ChevronRight size={14} className="imp-chev" />
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
      <h3>Open recalls</h3>
      {recalls.slice(0, 3).map((r) => (
        <div className="task-card" key={r.id}>
          <div className="task-title"><AlertTriangle size={17} /> {r.component ?? "Recall campaign"}</div>
          <div className="muted small">Campaign #{r.nhtsa_campaign_id}</div>
          {r.summary && <p className="small">{truncate(r.summary, 220)}</p>}
          {r.remedy && <p className="small"><strong>Remedy:</strong> {truncate(r.remedy, 180)}</p>}
        </div>
      ))}
      {recalls.length > 3 && <p className="muted small">+{recalls.length - 3} more in full history</p>}
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
// TASKS TAB — recommendations + active work + provider outreach
// ============================================================
function TaskCenter({
  dashboard,
  tasks,
  providers,
  autonomy,
  onRefresh
}: {
  dashboard: Dashboard;
  tasks: Task[];
  providers: Provider[];
  autonomy: AutonomyStatus | null;
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
      {autonomy && <AutonomyBadge autonomy={autonomy} />}

      <div className="panel">
        <h2>What Automoteev recommends</h2>
        {dashboard.insights.length === 0 ? (
          <p className="muted">Nothing to do — your vehicle is fully covered.</p>
        ) : (
          <div className="recs-grid">
            {dashboard.insights.map((insight) => (
              <RecommendationCard key={insight.key} insight={insight} />
            ))}
          </div>
        )}
      </div>

      <ProviderOutreach providers={providers} tasks={groups.active} autonomy={autonomy} onRefresh={onRefresh} />

      <div className="panel">
        <h2>Active tasks</h2>
        {groups.active.length === 0 ? (
          <p className="muted">No active tasks. Approve a recommendation above to get started.</p>
        ) : (
          groups.active.map((task) => (
            <article className="task-card" key={task.id}>
              <div className="task-title"><Wrench size={17} /> {task.title}</div>
              <div className={`status-chip status-${task.status}`}>{task.status.replaceAll("_", " ")}</div>
              {task.approval_summary && <p>{task.approval_summary}</p>}
              {task.shared_fields?.length ? (
                <p className="muted">Shared after approval: {task.shared_fields.join(", ")}</p>
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

function RecommendationCard({ insight }: { insight: Insight }) {
  const tone =
    insight.severity === "urgent" ? "rec-urgent" : insight.severity === "recommended" ? "rec-recommended" : "rec-info";
  return (
    <div className={`rec-card ${tone}`}>
      <div className="rec-card-head">
        {insight.severity === "urgent" ? <AlertTriangle size={18} /> : insight.category === "savings" ? <DollarSign size={18} /> : <Sparkles size={18} />}
        <strong>{insight.title}</strong>
      </div>
      <p className="small">{insight.body}</p>
      {insight.estimated_savings_usd_per_year ? (
        <p className="small savings-hint">Estimated savings: ~${insight.estimated_savings_usd_per_year}/year</p>
      ) : null}
      <div className="muted small">{insight.cta_label}</div>
    </div>
  );
}

function AutonomyBadge({ autonomy }: { autonomy: AutonomyStatus }) {
  if (autonomy.autonomy_unlocked) {
    return (
      <div className="panel autonomy-badge unlocked">
        <ShieldCheck size={18} />
        <div>
          <strong>Autonomy unlocked.</strong> Automoteev can now send outbound email on approved tasks
          without per-email approval.
        </div>
      </div>
    );
  }
  const remaining = Math.max(0, autonomy.threshold - autonomy.approved_email_count);
  return (
    <div className="panel autonomy-badge">
      <Info size={18} />
      <div>
        <strong>{remaining} more approval{remaining === 1 ? "" : "s"} until autonomy unlocks.</strong>{" "}
        Automoteev will ask before every outbound email for now. After {autonomy.threshold} approved sends,
        it can act on your approved tasks automatically.
      </div>
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

  return (
    <div className="panel outreach-panel">
      <div>
        <h2>Provider outreach</h2>
        <p className="muted small">Add a provider manually, or let Automoteev find one. Email outreach requires Pro and an approved task.</p>
      </div>
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
        `Got it. Automoteev is on it — "${command}". You'll get an approval request before any provider is contacted, and live updates as work happens.`
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
// HISTORY TAB — completed + cancelled + failed live here, quietly
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
            <p><strong>Free:</strong> dashboard, recall checks, savings recommendations, basic alerts.</p>
            <p><strong>Pro $4.99/month or $49/year:</strong> autonomous agent outreach, multi-vehicle, advanced alerts, OBD dongle.</p>
            <div className="button-row">
              <button className="primary" onClick={() => checkout("monthly")}>Upgrade — $4.99/mo</button>
              <button className="secondary" onClick={() => checkout("annual")}>Upgrade — $49/yr (save ~18%)</button>
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

        <h2 style={{ marginTop: 20 }}>Autonomy</h2>
        {autonomy ? (
          autonomy.autonomy_unlocked ? (
            <p>Unlocked. Automoteev can send email on approved tasks without per-email approval.</p>
          ) : (
            <p>{Math.max(0, autonomy.threshold - autonomy.approved_email_count)} more approvals until autonomy unlocks.</p>
          )
        ) : (
          <p className="muted">Loading…</p>
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
