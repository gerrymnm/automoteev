import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { AlertTriangle, CheckCircle2, Clock3, Lock, Mail, Plus, Send, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { api, money, vehicleName } from "./api";
import { isSupabaseConfigured, supabase } from "./supabase";
import type { Dashboard, Provider, Task, Vehicle } from "./types";

type Tab = "status" | "tasks" | "command" | "sell" | "settings";

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
        const [dash, taskResponse, providerResponse] = await Promise.all([
          api<Dashboard>(`/api/vehicles/${nextId}/dashboard`),
          api<{ tasks: Task[] }>("/api/tasks"),
          api<{ providers: Provider[] }>("/api/providers")
        ]);
        setDashboard(dash);
        setTasks(taskResponse.tasks);
        setProviders(providerResponse.providers);
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

      {tab === "status" && dashboard && <Status dashboard={dashboard} onRefresh={refresh} />}
      {tab === "tasks" && <TaskCenter tasks={tasks} providers={providers} onRefresh={refresh} />}
      {tab === "command" && selectedId && <Command vehicleId={selectedId} onCreated={refresh} />}
      {tab === "sell" && selectedId && <SellFlow vehicleId={selectedId} onCreated={refresh} />}
      {tab === "settings" && <Settings />}
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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (result.error) setError(result.error.message);
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
        <button className="primary" type="submit">{mode === "signin" ? "Sign in" : "Sign up"}</button>
        <button className="ghost" type="button" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
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
    apr_bps: "",
    lender_name: "",
    loan_lease_balance_cents: "",
    lease_maturity_date: "",
    insurance_carrier: "",
    insurance_premium_cents: "",
    insurance_renewal_date: ""
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api("/api/onboarding", {
        method: "POST",
        body: JSON.stringify(normalizeForm(form))
      });
      onDone();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Onboarding failed.");
    }
  }

  return (
    <form className="panel onboarding" onSubmit={submit}>
      <h1>Set up your vehicle</h1>
      <p className="muted">Only enter what Automoteev needs to keep ownership status accurate.</p>
      <div className="form-grid">
        <Field label="Name" value={form.full_name} onChange={(value) => setForm({ ...form, full_name: value })} required />
        <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} required />
        <Field label="ZIP code" value={form.zip_code} onChange={(value) => setForm({ ...form, zip_code: value })} required />
        <Field label="VIN" value={form.vin} onChange={(value) => setForm({ ...form, vin: value })} required />
        <Field label="Mileage" value={form.mileage} onChange={(value) => setForm({ ...form, mileage: value })} required />
        <label>Ownership type<select value={form.ownership_type} onChange={(event) => setForm({ ...form, ownership_type: event.target.value })}>
          <option value="owned">Owned</option><option value="financed">Financed</option><option value="leased">Leased</option>
        </select></label>
        <Field label="Monthly payment" value={form.monthly_payment_cents} onChange={(value) => setForm({ ...form, monthly_payment_cents: value })} money />
        <Field label="APR basis points" value={form.apr_bps} onChange={(value) => setForm({ ...form, apr_bps: value })} />
        <Field label="Lender name" value={form.lender_name} onChange={(value) => setForm({ ...form, lender_name: value })} />
        <Field label="Loan/lease balance" value={form.loan_lease_balance_cents} onChange={(value) => setForm({ ...form, loan_lease_balance_cents: value })} money />
        <Field label="Lease maturity date" value={form.lease_maturity_date} onChange={(value) => setForm({ ...form, lease_maturity_date: value })} type="date" />
        <Field label="Insurance carrier" value={form.insurance_carrier} onChange={(value) => setForm({ ...form, insurance_carrier: value })} />
        <Field label="Insurance premium" value={form.insurance_premium_cents} onChange={(value) => setForm({ ...form, insurance_premium_cents: value })} money />
        <Field label="Insurance renewal" value={form.insurance_renewal_date} onChange={(value) => setForm({ ...form, insurance_renewal_date: value })} type="date" />
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
          <span className="status-pill">{status === "all_good" ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} {statusText}</span>
        </div>
        <div className="metric-grid">
          <Metric label="Monthly cost" value={money(dashboard.cost_profile?.total_monthly_cost_cents)} />
          <Metric label="Estimated value" value={money(dashboard.vehicle.estimated_value_cents)} />
          <Metric label="Loan/lease balance" value={money(dashboard.loan_lease?.balance_cents)} />
          <Metric label="Insurance" value={dashboard.insurance?.carrier_name ?? "Missing"} />
          <Metric label="Next service" value={dashboard.vehicle.next_service_due_miles ? `${dashboard.vehicle.next_service_due_miles.toLocaleString()} mi` : "Missing"} />
          <Metric label="Recall" value={dashboard.vehicle.recall_status ?? "Unknown"} />
        </div>
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
        <div className="privacy-note"><Lock size={16} /> Automoteev logs actions and never contacts providers without approval.</div>
      </aside>
    </section>
  );
}

function TaskCenter({ tasks, providers, onRefresh }: { tasks: Task[]; providers: Provider[]; onRefresh: () => void }) {
  const groups = useMemo(() => ({
    active: tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)),
    completed: tasks.filter((task) => task.status === "completed"),
    failed: tasks.filter((task) => task.status === "failed")
  }), [tasks]);

  async function approve(task: Task, approved: boolean) {
    await api(`/api/tasks/${task.id}/approval`, { method: "POST", body: JSON.stringify({ approved }) });
    onRefresh();
  }

  return (
    <section className="task-page">
      <ProviderOutreach providers={providers} tasks={groups.active} onRefresh={onRefresh} />
      <div className="task-grid">
        <TaskColumn title="Active tasks" tasks={groups.active} onApprove={approve} />
        <TaskColumn title="Completed" tasks={groups.completed} />
        <TaskColumn title="Failed" tasks={groups.failed} />
      </div>
    </section>
  );
}

function ProviderOutreach({ providers, tasks, onRefresh }: { providers: Provider[]; tasks: Task[]; onRefresh: () => void }) {
  const approvedTasks = tasks.filter((task) => task.status === "approved");
  const [form, setForm] = useState({ name: "", email: "", phone: "", provider_type: "service", location: "" });
  const [selectedTask, setSelectedTask] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  async function saveProvider(event: React.FormEvent) {
    event.preventDefault();
    await api("/api/providers", { method: "POST", body: JSON.stringify(normalizeForm(form)) });
    setForm({ name: "", email: "", phone: "", provider_type: "service", location: "" });
    onRefresh();
  }

  async function sendEmail() {
    setMessage(null);
    try {
      await api(`/api/tasks/${selectedTask}/emails`, { method: "POST", body: JSON.stringify({ provider_id: selectedProvider, notes }) });
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
        <p className="muted">Add a provider manually. Email outreach is sent only after task approval and requires Pro.</p>
      </div>
      <form className="provider-form" onSubmit={saveProvider}>
        <Field label="Provider name" value={form.name} onChange={(value) => setForm({ ...form, name: value })} required />
        <Field label="Email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} type="email" />
        <Field label="Phone" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
        <label>Type<select value={form.provider_type} onChange={(event) => setForm({ ...form, provider_type: event.target.value })}>
          <option value="service">Service</option><option value="insurance">Insurance</option><option value="lender">Lender</option><option value="buyer">Buyer</option>
        </select></label>
        <Field label="Location" value={form.location} onChange={(value) => setForm({ ...form, location: value })} />
        <button className="secondary" type="submit">Add provider</button>
      </form>
      <div className="provider-form">
        <label>Approved task<select value={selectedTask} onChange={(event) => setSelectedTask(event.target.value)}>
          <option value="">Select task</option>
          {approvedTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select></label>
        <label>Provider<select value={selectedProvider} onChange={(event) => setSelectedProvider(event.target.value)}>
          <option value="">Select provider</option>
          {providers.filter((provider) => provider.email).map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
        </select></label>
        <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        <button className="primary" disabled={!selectedTask || !selectedProvider} onClick={sendEmail} type="button"><Mail size={18} /> Send approved email</button>
      </div>
      {message && <div className="notice">{message}</div>}
    </div>
  );
}

function TaskColumn({ title, tasks, onApprove }: { title: string; tasks: Task[]; onApprove?: (task: Task, approved: boolean) => void }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      {tasks.length === 0 && <p className="muted">Nothing here.</p>}
      {tasks.map((task) => (
        <article className="task-card" key={task.id}>
          <div className="task-title"><Wrench size={17} /> {task.title}</div>
          <div className="status-chip">{task.status.replaceAll("_", " ")}</div>
          {task.approval_summary && <p>{task.approval_summary}</p>}
          {task.shared_fields?.length ? <p className="muted">Shared after approval: {task.shared_fields.join(", ")}</p> : null}
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
        <label>Condition<select value={form.condition} onChange={(event) => setForm({ ...form, condition: event.target.value })}>
          <option value="excellent">Excellent</option><option value="good">Good</option><option value="fair">Fair</option><option value="poor">Poor</option>
        </select></label>
        <Field label="Payoff amount" value={form.payoff_amount_cents} onChange={(value) => setForm({ ...form, payoff_amount_cents: value })} money />
        <Field label="Photo upload placeholder" value="Coming soon: secure document storage" onChange={() => undefined} />
      </div>
      <label>Notes<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
      <button className="primary" type="submit"><Sparkles size={18} /> Create sale package task</button>
    </form>
  );
}

function Settings() {
  async function checkout() {
    const result = await api<{ url: string | null; configured: boolean }>("/api/billing/create-checkout-session", { method: "POST" });
    if (result.url) window.location.assign(result.url);
    else alert("Stripe is not configured yet. Add STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID.");
  }

  return (
    <section className="settings-grid">
      <div className="panel">
        <h2>Plans</h2>
        <p><strong>Free:</strong> dashboard, recall checks, cost tracking, basic alerts.</p>
        <p><strong>Pro $4.99/month:</strong> task execution, email outreach, quote requests, appointment requests, multi-vehicle, advanced alerts.</p>
        <button className="primary" onClick={checkout}>Upgrade to Pro</button>
      </div>
      <div className="panel">
        <h2>Privacy</h2>
        <p>Every important action is logged. External sharing requires approval that names who may be contacted and which fields may be shared.</p>
        <div className="trust-row"><Mail size={18} /> Task email uses tasks@automoteev.com.</div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Field({ label, value, onChange, required, type = "text", money: isMoney }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string; money?: boolean }) {
  return <label>{label}<input value={value} onChange={(event) => onChange(event.target.value)} required={required} type={isMoney ? "number" : type} min={isMoney ? 0 : undefined} /></label>;
}

function normalizeForm<T extends Record<string, string>>(form: T) {
  return Object.fromEntries(Object.entries(form).map(([key, value]) => {
    if (value === "") return [key, null];
    if (key.endsWith("_cents")) return [key, Math.round(Number(value) * 100)];
    if (["mileage", "apr_bps"].includes(key)) return [key, Number(value)];
    return [key, value];
  }));
}
