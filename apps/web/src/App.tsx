import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Info,
  Lock,
  Mail,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
  X
} from "lucide-react";
import { api, money, vehicleName } from "./api";
import { isSupabaseConfigured, supabase } from "./supabase";
import type {
  AutonomyStatus,
  Dashboard,
  MaintenanceItem,
  OnboardingPrompt,
  Provider,
  RecallRecord,
  SubscriptionStatus,
  Task,
  Vehicle
} from "./types";

type Tab = "status" | "tasks" | "command" | "sell" | "settings";

const FIELD_LABELS: Record<string, string> = {
  monthly_payment: "Monthly loan or lease payment",
  loan_balance: "Loan or lease balance",
  loan_apr: "Loan APR",
  loan_start_date: "Loan start date",
  loan_term_months: "Loan term (months)",
  insurance_premium: "Insurance premium",
  insurance_renewal: "Insurance renewal date",
  insurance_coverage: "Insurance coverage type",
  phone: "Phone number",
  street_address: "Street address",
  drivers_license: "Driver's license"
};

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

  if (loading) return <Shell><div className="panel">Loading secure session...</div></Shell>;
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
  const [prompts, setPrompts] = useState<OnboardingPrompt[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const vehicleResponse = await api<{ vehicles: Vehicle[] }>("/api/vehicles");
      setVehicles(vehicleResponse.vehicles);
      const nextId = selectedId ?? vehicleResponse.vehicles[0]?.id ?? null;
      setSelectedId(nextId);
      if (nextId) {
        const [dash, taskResponse, providerResponse, autonomyResponse, promptsResponse] = await Promise.all([
          api<Dashboard>(`/api/vehicles/${nextId}/dashboard`),
          api<{ tasks: Task[] }>("/api/tasks"),
          api<{ providers: Provider[] }>("/api/providers"),
          api<AutonomyStatus>("/api/autonomy/status"),
          api<{ prompts: OnboardingPrompt[] }>("/api/onboarding/prompts")
        ]);
        setDashboard(dash);
        setTasks(taskResponse.tasks);
        setProviders(providerResponse.providers);
        setAutonomy(autonomyResponse);
        setPrompts(promptsResponse.prompts);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function dismissPrompt(field: string) {
    await api(`/api/onboarding/prompts/${field}/dismiss`, { method: "POST" });
    setPrompts((current) => current.filter((p) => p.field_name !== field));
  }

  if (!vehicles.length) {
    return <Shell><Onboarding onDone={refresh} email={session.user.email ?? ""} /></Shell>;
  }

  return (
    <Shell>
      <header className="topbar">
        <div>
          <div className="brand">Automoteev</div>
          <div className="muted">Private vehicle ownership agent</div>
        </div>
        <nav className="tabs" aria-label="Main">
          {(["status", "tasks", "command", "sell", "settings"] as Tab[]).map((item) => (
            <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
              {item}
            </button>
          ))}
        </nav>
      </header>

      {message && <div className="notice">{message}</div>}
      {busy && <div className="thin-status">Syncing secure vehicle data...</div>}

      {prompts.length > 0 && <NudgesBanner prompts={prompts} onDismiss={dismissPrompt} />}

      {tab === "status" && dashboard && (
        <Status dashboard={dashboard} onRefresh={refresh} />
      )}
      {tab === "tasks" && (
        <TaskCenter
          tasks={tasks}
          providers={providers}
          autonomy={autonomy}
          onRefresh={refresh}
        />
      )}
      {tab === "command" && selectedId && <Command vehicleId={selectedId} onCreated={refresh} />}
      {tab === "sell" && selectedId && <SellFlow vehicleId={selectedId} onCreated={refresh} />}
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
        if (result.error) {
          setError(result.error.message);
        } else if (result.data.session) {
          // Email confirmation disabled — session exists, parent will pick it up.
        } else {
          setInfo(
            "Check your email and click the confirmation link to finish creating your account. The link will return you here."
          );
        }
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
        <h1>Know what your vehicle needs, then approve what happens next.</h1>
        <p>Secure, alert-driven ownership support for recalls, service, insurance, payoff requests, and sale prep.</p>
        <div className="trust-row"><ShieldCheck size={18} /> No provider outreach without explicit approval.</div>
      </div>
      <form className="panel auth-card" onSubmit={submit}>
        <h2>{mode === "signin" ? "Sign in" : "Create account"}</h2>
        <label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label>
        <label>Password<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} required /></label>
        {error && <div className="error">{error}</div>}
        {info && <div className="notice">{info}</div>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
        <button
          className="ghost"
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setInfo(null);
          }}
        >
          {mode === "signin" ? "Create an account" : "Already have an account"}
        </button>
      </form>
    </section>
  );
}

function NudgesBanner({
  prompts,
  onDismiss
}: {
  prompts: OnboardingPrompt[];
  onDismiss: (field: string) => void;
}) {
  return (
    <div className="panel nudges">
      <div className="nudges-head">
        <Info size={18} />
        <strong>Add the following to improve Automoteev's recommendations</strong>
      </div>
      <ul className="nudges-list">
        {prompts.map((p) => (
          <li key={p.field_name}>
            <span>{FIELD_LABELS[p.field_name] ?? p.field_name}</span>
            <button className="ghost small" type="button" onClick={() => onDismiss(p.field_name)}>
              <X size={14} /> Dismiss
            </button>
          </li>
        ))}
      </ul>
      <div className="muted small">
        We'll nudge you again on a gentle cadence until these are filled in or dismissed.
      </div>
    </div>
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
    apr_bps: "",
    lender_name: "",
    loan_lease_balance_cents: "",
    principal_cents: "",
    term_months: "",
    loan_start_date: "",
    first_payment_date: "",
    rate_type: "",
    lease_maturity_date: "",
    insurance_carrier: "",
    insurance_premium_cents: "",
    insurance_renewal_date: "",
    insurance_coverage_type: "",
    insurance_deductible_cents: "",
    insurance_liability_limits: "",
    insurance_policy_number: ""
  });
  const [consents, setConsents] = useState({
    reserve_obd: true,
    accepted_tos: false,
    accepted_privacy: false,
    accepted_autonomy_consent: false
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!consents.accepted_tos || !consents.accepted_privacy || !consents.accepted_autonomy_consent) {
      setError("Please accept all three agreements to continue.");
      return;
    }
    try {
      await api("/api/onboarding", {
        method: "POST",
        body: JSON.stringify({ ...normalizeForm(form), ...consents })
      });
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Onboarding failed.");
    }
  }

  return (
    <form className="panel onboarding" onSubmit={submit}>
      <h1>Set up your vehicle</h1>
      <p className="muted">
        Only VIN, mileage, and email are required. Skip anything you don't have handy —
        Automoteev will nudge you later to fill in the rest.
      </p>

      <h3 className="section-head">Who you are</h3>
      <div className="form-grid">
        <Field label="Name" value={form.full_name} onChange={(value) => setForm({ ...form, full_name: value })} required />
        <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} required />
        <Field label="ZIP code" value={form.zip_code} onChange={(value) => setForm({ ...form, zip_code: value })} required />
      </div>

      <h3 className="section-head">Your vehicle</h3>
      <div className="form-grid">
        <Field label="VIN" value={form.vin} onChange={(value) => setForm({ ...form, vin: value.toUpperCase() })} required />
        <Field label="Mileage" value={form.mileage} onChange={(value) => setForm({ ...form, mileage: value })} required />
        <label>Ownership type
          <select value={form.ownership_type} onChange={(event) => setForm({ ...form, ownership_type: event.target.value })}>
            <option value="owned">Owned</option>
            <option value="financed">Financed</option>
            <option value="leased">Leased</option>
          </select>
        </label>
      </div>

      <h3 className="section-head">Loan or lease <span className="muted">(optional)</span></h3>
      <div className="form-grid">
        <Field label="Lender" value={form.lender_name} onChange={(value) => setForm({ ...form, lender_name: value })} />
        <Field label="Monthly payment" value={form.monthly_payment_cents} onChange={(value) => setForm({ ...form, monthly_payment_cents: value })} money />
        <Field label="Current balance" value={form.loan_lease_balance_cents} onChange={(value) => setForm({ ...form, loan_lease_balance_cents: value })} money />
        <Field label="Original principal" value={form.principal_cents} onChange={(value) => setForm({ ...form, principal_cents: value })} money />
        <Field label="APR (basis points)" value={form.apr_bps} onChange={(value) => setForm({ ...form, apr_bps: value })} />
        <Field label="Term (months)" value={form.term_months} onChange={(value) => setForm({ ...form, term_months: value })} />
        <Field label="Loan start date" value={form.loan_start_date} onChange={(value) => setForm({ ...form, loan_start_date: value })} type="date" />
        <Field label="First payment date" value={form.first_payment_date} onChange={(value) => setForm({ ...form, first_payment_date: value })} type="date" />
        <label>Rate type
          <select value={form.rate_type} onChange={(event) => setForm({ ...form, rate_type: event.target.value })}>
            <option value="">—</option>
            <option value="fixed">Fixed</option>
            <option value="variable">Variable</option>
          </select>
        </label>
        <Field label="Lease maturity date" value={form.lease_maturity_date} onChange={(value) => setForm({ ...form, lease_maturity_date: value })} type="date" />
      </div>

      <h3 className="section-head">Insurance <span className="muted">(optional)</span></h3>
      <div className="form-grid">
        <Field label="Carrier" value={form.insurance_carrier} onChange={(value) => setForm({ ...form, insurance_carrier: value })} />
        <Field label="Monthly premium" value={form.insurance_premium_cents} onChange={(value) => setForm({ ...form, insurance_premium_cents: value })} money />
        <Field label="Renewal date" value={form.insurance_renewal_date} onChange={(value) => setForm({ ...form, insurance_renewal_date: value })} type="date" />
        <label>Coverage type
          <select value={form.insurance_coverage_type} onChange={(event) => setForm({ ...form, insurance_coverage_type: event.target.value })}>
            <option value="">—</option>
            <option value="liability">Liability only</option>
            <option value="full">Full coverage</option>
            <option value="comprehensive">Comprehensive</option>
            <option value="unknown">Not sure</option>
          </select>
        </label>
        <Field label="Deductible" value={form.insurance_deductible_cents} onChange={(value) => setForm({ ...form, insurance_deductible_cents: value })} money />
        <Field label="Liability limits (e.g. 100/300/100)" value={form.insurance_liability_limits} onChange={(value) => setForm({ ...form, insurance_liability_limits: value })} />
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
      <button className="primary" type="submit"><Plus size={18} /> Create vehicle profile</button>
    </form>
  );
}

function Status({ dashboard, onRefresh }: { dashboard: Dashboard; onRefresh: () => void }) {
  const status = dashboard.vehicle.overall_status;
  const statusText = status === "all_good" ? "All good" : status === "action_needed" ? "Action needed" : "Action recommended";

  return (
    <section className="status-layout">
      <div className={`status-hero ${status}`}>
        <div className="status-head">
          <div>
            <p className="muted">Vehicle status</p>
            <h1>{vehicleName(dashboard.vehicle)}</h1>
          </div>
          <span className="status-pill">
            {status === "all_good" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {statusText}
          </span>
        </div>
        <div className="metric-grid">
          <Metric label="Monthly cost" value={money(dashboard.cost_profile?.total_monthly_cost_cents)} />
          <Metric label="Estimated value" value={money(dashboard.vehicle.estimated_value_cents)} />
          <Metric label="Loan/lease balance" value={money(dashboard.loan_lease?.balance_cents)} />
          <Metric label="Insurance" value={dashboard.insurance?.carrier_name ?? "Missing"} />
          <Metric label="Next service" value={dashboard.vehicle.next_service_due_miles ? `${dashboard.vehicle.next_service_due_miles.toLocaleString()} mi` : "Missing"} />
          <Metric label="Recall" value={dashboard.vehicle.recall_status ?? "Unknown"} />
        </div>

        {dashboard.open_recalls && dashboard.open_recalls.length > 0 && (
          <RecallList recalls={dashboard.open_recalls} />
        )}

        {dashboard.maintenance_items && dashboard.maintenance_items.length > 0 && (
          <MaintenanceList items={dashboard.maintenance_items} />
        )}
      </div>

      <aside className="side-panel">
        <h2>Recommended action</h2>
        {dashboard.recommended_action ? (
          <div className="action-box">
            <strong>{dashboard.recommended_action.title}</strong>
            <p>{dashboard.recommended_action.body}</p>
          </div>
        ) : <p className="muted">No action needed right now.</p>}
        <button className="secondary" onClick={onRefresh}><Clock3 size={18} /> Refresh status</button>
        <div className="privacy-note">
          <Lock size={16} /> Automoteev logs every action and never contacts providers without approval.
        </div>
      </aside>
    </section>
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
  const upcoming = items
    .filter((i) => i.status === "upcoming" || i.status === "due" || i.status === "overdue")
    .slice(0, 4);
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

function TaskCenter({
  tasks,
  providers,
  autonomy,
  onRefresh
}: {
  tasks: Task[];
  providers: Provider[];
  autonomy: AutonomyStatus | null;
  onRefresh: () => void;
}) {
  const groups = useMemo(
    () => ({
      active: tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)),
      completed: tasks.filter((task) => task.status === "completed"),
      failed: tasks.filter((task) => task.status === "failed")
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
      <ProviderOutreach providers={providers} tasks={groups.active} autonomy={autonomy} onRefresh={onRefresh} />
      <div className="task-grid">
        <TaskColumn title="Active tasks" tasks={groups.active} onApprove={approve} />
        <TaskColumn title="Completed" tasks={groups.completed} />
        <TaskColumn title="Failed" tasks={groups.failed} />
      </div>
    </section>
  );
}

function AutonomyBadge({ autonomy }: { autonomy: AutonomyStatus }) {
  if (autonomy.autonomy_unlocked) {
    return (
      <div className="panel autonomy-badge unlocked">
        <ShieldCheck size={18} />
        <div>
          <strong>Autonomy unlocked.</strong> Automoteev can now send outbound email on approved tasks
          without per-email approval. You can revoke any time from Settings.
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
        it can send on your approved tasks automatically.
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
      window.confirm(
        "This email will be sent as you, from your Automoteev alias. Phone is not disclosed. Proceed?"
      );
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
        <p className="muted">Add a provider manually. Email outreach requires Pro and a task in "approved" status.</p>
      </div>
      <form className="provider-form" onSubmit={saveProvider}>
        <Field label="Provider name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} required />
        <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} type="email" />
        <Field label="Phone" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
        <label>Type
          <select value={form.provider_type} onChange={(event) => setForm({ ...form, provider_type: event.target.value })}>
            <option value="service_shop">Service shop</option>
            <option value="dealership_service">Dealership service</option>
            <option value="oil_change">Oil change</option>
            <option value="tire_shop">Tire shop</option>
            <option value="body_shop">Body shop</option>
            <option value="insurance_agent">Insurance agent</option>
            <option value="buying_center">Buying center</option>
          </select>
        </label>
        <Field label="Location" value={form.location} onChange={(value) => setForm({ ...form, location: value })} />
        <button className="secondary" type="submit">Add provider</button>
      </form>
      <div className="provider-form">
        <label>Approved task
          <select value={selectedTask} onChange={(event) => setSelectedTask(event.target.value)}>
            <option value="">Select task</option>
            {approvedTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
          </select>
        </label>
        <label>Provider
          <select value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value)}>
            <option value="">Select provider</option>
            {providers.filter((provider) => provider.email).map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </label>
        <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <button className="primary" disabled={!selectedTask || !selectedProvider} onClick={sendEmail} type="button">
          <Mail size={18} /> {autonomy?.requires_approval_for_next_send ? "Approve & send" : "Send email"}
        </button>
      </div>
      {message && <div className="notice">{message}</div>}
    </div>
  );
}

function TaskColumn({
  title,
  tasks,
  onApprove
}: {
  title: string;
  tasks: Task[];
  onApprove?: (task: Task, approved: boolean) => void;
}) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {tasks.length === 0 && <p className="muted">Nothing here.</p>}
      {tasks.map((task) => (
        <article className="task-card" key={task.id}>
          <div className="task-title"><Wrench size={17} /> {task.title}</div>
          <div className="status-chip">{task.status.replaceAll("_", " ")}</div>
          {task.approval_summary && <p>{task.approval_summary}</p>}
          {task.shared_fields?.length ? (
            <p className="muted">Shared after approval: {task.shared_fields.join(", ")}</p>
          ) : null}
          {task.status === "needs_user_approval" && onApprove && (
            <div className="button-row">
              <button className="primary" onClick={() => onApprove(task, true)}>Approve</button>
              <button className="ghost" onClick={() => onApprove(task, false)}>Cancel</button>
            </div>
          )}
          <div className="muted small">Provider responses, email history, and audit history are tracked per task.</div>
        </article>
      ))}
    </div>
  );
}

function Command({ vehicleId, onCreated }: { vehicleId: string; onCreated: () => void }) {
  const [command, setCommand] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await api("/api/tasks/command", { method: "POST", body: JSON.stringify({ vehicle_id: vehicleId, command }) });
    setCommand("");
    onCreated();
  }

  return (
    <form className="panel command-panel" onSubmit={submit}>
      <h1>Ask Automoteev to handle something</h1>
      <div className="quick-commands">
        {["Find cheaper insurance", "Book service", "Check recalls", "Help me sell my car", "Review my loan", "Get my payoff"].map((item) => (
          <button type="button" className="secondary" key={item} onClick={() => setCommand(item)}>{item}</button>
        ))}
      </div>
      <label>Command<input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Find cheaper insurance" required /></label>
      <button className="primary" type="submit"><Send size={18} /> Create structured task</button>
    </form>
  );
}

function SellFlow({ vehicleId, onCreated }: { vehicleId: string; onCreated: () => void }) {
  const [form, setForm] = useState({ mileage: "", condition: "good", payoff_amount_cents: "", notes: "" });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await api(`/api/sell-vehicle/${vehicleId}`, { method: "POST", body: JSON.stringify(normalizeForm(form)) });
    onCreated();
  }

  return (
    <form className="panel onboarding" onSubmit={submit}>
      <h1>Prepare to sell</h1>
      <p className="muted">Automoteev builds a sale package first. Outreach waits for approval.</p>
      <div className="form-grid">
        <Field label="Current mileage" value={form.mileage} onChange={(value) => setForm({ ...form, mileage: value })} required />
        <label>Condition
          <select value={form.condition} onChange={(event) => setForm({ ...form, condition: event.target.value })}>
            <option value="excellent">Excellent</option>
            <option value="good">Good</option>
            <option value="fair">Fair</option>
            <option value="poor">Poor</option>
          </select>
        </label>
        <Field label="Payoff amount" value={form.payoff_amount_cents} onChange={(value) => setForm({ ...form, payoff_amount_cents: value })} money />
        <Field label="Photo upload placeholder" value="Coming soon: secure document storage" onChange={() => undefined} />
      </div>
      <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      <button className="primary" type="submit"><Sparkles size={18} /> Create sale package task</button>
    </form>
  );
}

function Settings({ autonomy }: { autonomy: AutonomyStatus | null }) {
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);

  useEffect(() => {
    void api<SubscriptionStatus>("/api/subscription/status")
      .then(setSubscription)
      .catch(() => undefined);
  }, []);

  async function checkout(plan: "monthly" | "annual") {
    const result = await api<{ url: string | null; configured: boolean }>("/api/billing/create-checkout-session", {
      method: "POST",
      body: JSON.stringify({ plan })
    });
    if (result.url) window.location.assign(result.url);
    else alert("Stripe is not configured yet. Add STRIPE_SECRET_KEY and STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL.");
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
            <p><strong>Free:</strong> dashboard, recall checks, cost tracking, basic alerts.</p>
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
              Automoteev sends outbound provider email from this address on your behalf. Dealer replies
              route back here automatically and attach to the right task.
            </p>
          </>
        ) : (
          <p className="muted">Alias will be assigned after your first vehicle is created.</p>
        )}

        <h2 style={{ marginTop: 20 }}>Autonomy</h2>
        {autonomy ? (
          autonomy.autonomy_unlocked ? (
            <p>
              Unlocked on{" "}
              {autonomy.autonomy_unlocked_at
                ? new Date(autonomy.autonomy_unlocked_at).toLocaleDateString()
                : "—"}
              . Automoteev can send email on approved tasks without per-email approval.
            </p>
          ) : (
            <p>
              {Math.max(0, autonomy.threshold - autonomy.approved_email_count)} more approval
              {autonomy.threshold - autonomy.approved_email_count === 1 ? "" : "s"} until autonomy unlocks.
            </p>
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

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({
  label,
  value,
  onChange,
  required,
  type = "text",
  money: isMoney
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
  money?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        type={isMoney ? "number" : type}
        min={isMoney ? 0 : undefined}
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
      if (["mileage", "apr_bps", "term_months"].includes(key)) return [key, Number(value)];
      return [key, value];
    })
  );
}
