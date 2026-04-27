import { useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, Link } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Camera,
  CheckCircle2,
  ChevronRight,
  Clock3,
  DollarSign,
  ExternalLink,
  FileImage,
  Info,
  Loader2,
  Lock,
  LogOut,
  Mail,
  MapPin,
  Phone,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Wrench,
  X
} from "lucide-react";
import { api, money, moneyRange, vehicleName } from "./api";
import { isSupabaseConfigured, supabase } from "./supabase";
import type {
  AutonomyStatus,
  Dashboard,
  DispatchPayload,
  DispatchProvider,
  Insight,
  MaintenanceItem,
  Provider,
  RecallRecord,
  SubscriptionStatus,
  Task,
  UploadedDocument,
  Vehicle
} from "./types";

// Task types that go through the discovery + dispatch flow.
// Must match isDispatchable() in apps/api/src/services/dealer-discovery.ts.
const DISPATCHABLE_TASK_TYPES = new Set([
  "recall_repair",
  "service_quote",
  "insurance_quote",
  "refinance",
  "sell_vehicle"
]);

function isDispatchableTaskType(t: string | null | undefined): boolean {
  return Boolean(t && DISPATCHABLE_TASK_TYPES.has(t));
}

type Tab = "status" | "tasks" | "command" | "history" | "settings";
type FormId = "insurance" | "loan" | "fuel" | "preferred_shop";

// ============================================================
// Session context
// ============================================================
interface SessionContextValue {
  session: Session | null;
  loading: boolean;
}
const SessionContext = createContext<SessionContextValue>({ session: null, loading: true });
export function useSession() {
  return useContext(SessionContext);
}

function SessionProvider({ children }: { children: React.ReactNode }) {
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

  return (
    <SessionContext.Provider value={{ session, loading }}>
      {children}
    </SessionContext.Provider>
  );
}

// Wraps a route that requires a signed-in user. Redirects to /signin if not.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <Shell><div className="panel">Loading secure session…</div></Shell>;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

// Wraps a route (like /signin) that should redirect a signed-in user away.
function RedirectIfAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession();
  if (loading) return <Shell><div className="panel">Loading…</div></Shell>;
  if (session) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

// ============================================================
// Top-level App = router host
// ============================================================
export function App() {
  // Imported lazily so adding the router doesn't require touching every page file.
  return (
    <BrowserRouter>
      <SessionProvider>
        {!isSupabaseConfigured ? (
          <Shell><SetupNotice /></Shell>
        ) : (
          <Routes>
            {/* Public marketing + auth */}
            <Route path="/" element={<RedirectIfAuth><LandingPage /></RedirectIfAuth>} />
            <Route path="/signin" element={<RedirectIfAuth><SignInPage /></RedirectIfAuth>} />
            <Route path="/signup" element={<RedirectIfAuth><SignUpPage /></RedirectIfAuth>} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/terms" element={<TermsPage />} />
            {/* Authenticated app */}
            <Route path="/app/*" element={<RequireAuth><AuthenticatedApp /></RequireAuth>} />
            {/* Fallback */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </SessionProvider>
    </BrowserRouter>
  );
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
  // Legacy combined sign-in/sign-up panel — retained as the inner shared form.
  return <SignInForm />;
}

/**
 * Auth form, used by both /signin and /signup pages.
 * `mode` controls which side of the toggle starts active.
 */
function AuthForm({ mode: initialMode }: { mode: "signin" | "signup" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">(initialMode);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

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
          options: { emailRedirectTo: `${window.location.origin}/app` }
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
        onClick={() => {
          const next = mode === "signin" ? "signup" : "signin";
          setMode(next);
          setError(null);
          setInfo(null);
          navigate(`/${next}`, { replace: true });
        }}
      >
        {mode === "signin" ? "Create an account" : "Already have an account"}
      </button>
    </form>
  );
}

function SignInForm() { return <AuthForm mode="signin" />; }
function SignUpForm() { return <AuthForm mode="signup" />; }

// ============================================================
// Public marketing pages
// ============================================================

// Top nav for public marketing pages — brand on the left, sign-in/up on the right.
function PublicNav() {
  return (
    <header className="public-nav">
      <Link className="public-brand" to="/">
        <span className="brand">Automoteev</span>
      </Link>
      <div className="public-nav-actions">
        <Link to="/signin" className="ghost">Sign in</Link>
        <Link to="/signup" className="primary public-cta">Get started — free</Link>
      </div>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <strong>Automoteev</strong>
          <p className="small muted">Your AI agent for life's recurring expenses.</p>
          <p className="small muted">Carculus Automotive LLC</p>
        </div>
        <div className="footer-links">
          <Link to="/privacy" className="small">Privacy</Link>
          <Link to="/terms" className="small">Terms</Link>
          <a href="mailto:gerry@carculus.ai" className="small">Contact</a>
        </div>
      </div>
    </footer>
  );
}

function LandingPage() {
  return (
    <div className="public-page">
      <PublicNav />
      <main className="landing-main">
        {/* HERO */}
        <section className="landing-hero">
          <div className="landing-hero-text">
            <h1>Save money on your monthly expenses. Without lifting a finger.</h1>
            <p className="landing-hero-sub">
              Starting with your car. Insurance, subscriptions, and recurring bills next.
            </p>
            <p className="landing-hero-body">
              Automoteev is the AI agent that watches your insurance, loan, and service costs,
              finds savings, requests quotes from real providers, and acts on your behalf. You
              only see the wins worth taking.
            </p>
            <div className="landing-cta-row">
              <Link to="/signup" className="primary big-cta">Get started — free</Link>
              <Link to="/signin" className="ghost big-cta-ghost">Sign in</Link>
            </div>
            <div className="trust-row">
              <ShieldCheck size={16} /> Nothing gets sent to a provider without your approval.
            </div>
          </div>
          <div className="landing-hero-visual" aria-hidden>
            <ProductPreviewCard />
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="landing-section">
          <h2 className="landing-section-title">How it works</h2>
          <p className="landing-section-sub">Three simple steps. No spreadsheets, no phone trees.</p>
          <div className="how-grid">
            <div className="how-card">
              <div className="how-step">1</div>
              <h3>Add your vehicle</h3>
              <p>VIN and mileage are enough. Snap a photo of your insurance dec page or loan statement and Automoteev fills in the rest.</p>
            </div>
            <div className="how-card">
              <div className="how-step">2</div>
              <h3>Automoteev finds savings</h3>
              <p>Open recalls, refinance opportunities, insurance shopping windows, lease-end timing, dealer offers — prioritized by what's worth your attention.</p>
            </div>
            <div className="how-card">
              <div className="how-step">3</div>
              <h3>Approve, the agent acts</h3>
              <p>One tap to dispatch. Automoteev contacts real providers from your dedicated agent email, learns who replies, and routes the conversation back to you.</p>
            </div>
          </div>
        </section>

        {/* WHAT'S COVERED */}
        <section className="landing-section landing-section-alt">
          <h2 className="landing-section-title">What Automoteev handles</h2>
          <p className="landing-section-sub">Vehicle today. Everything recurring next.</p>
          <div className="covered-grid">
            <div className="covered-card now">
              <span className="covered-pill">Available now</span>
              <h3><Wrench size={18} /> Vehicle</h3>
              <ul>
                <li>Open recall lookup + dealer outreach</li>
                <li>Insurance shopping</li>
                <li>Refinance &amp; payoff requests</li>
                <li>Service quotes from real shops</li>
                <li>Sale &amp; lease-end coordination</li>
              </ul>
            </div>
            <div className="covered-card next">
              <span className="covered-pill upcoming">Coming soon</span>
              <h3><ShieldCheck size={18} /> Home, life &amp; renters insurance</h3>
              <p>Same shop-and-save loop, applied to every policy you carry.</p>
            </div>
            <div className="covered-card next">
              <span className="covered-pill upcoming">Coming soon</span>
              <h3><DollarSign size={18} /> Subscription audits</h3>
              <p>Catches the streaming, software, and gym charges you forgot you signed up for.</p>
            </div>
            <div className="covered-card next">
              <span className="covered-pill upcoming">Coming soon</span>
              <h3><TrendingUp size={18} /> Recurring bill optimization</h3>
              <p>Internet, mobile, energy — negotiate or switch when better deals appear.</p>
            </div>
          </div>
        </section>

        {/* PRICING */}
        <section className="landing-section">
          <h2 className="landing-section-title">Pricing</h2>
          <p className="landing-section-sub">Free to start. Upgrade only when the agent works for you.</p>
          <div className="pricing-grid">
            <div className="pricing-card">
              <h3>Free</h3>
              <p className="pricing-amount">$0</p>
              <ul>
                <li>Vehicle dashboard &amp; valuation</li>
                <li>Recall lookup</li>
                <li>Savings recommendations</li>
                <li>Fuel log</li>
              </ul>
              <Link to="/signup" className="secondary pricing-cta">Get started</Link>
            </div>
            <div className="pricing-card pricing-card-pro">
              <span className="pricing-badge">Most popular</span>
              <h3>Pro</h3>
              <p className="pricing-amount">$9.99<span className="pricing-period">/mo</span></p>
              <p className="small muted">or $99/yr (save ~17%)</p>
              <ul>
                <li>Everything in Free</li>
                <li>Autonomous agent outreach to providers</li>
                <li>Document upload + AI auto-fill</li>
                <li>Multi-vehicle support</li>
                <li>OBD dongle reservation</li>
                <li>SMS channel (coming soon)</li>
              </ul>
              <Link to="/signup" className="primary pricing-cta">Start free, upgrade anytime</Link>
            </div>
          </div>
        </section>

        {/* TRUST */}
        <section className="landing-section landing-section-alt">
          <h2 className="landing-section-title">Built for trust</h2>
          <div className="trust-grid">
            <div className="trust-card">
              <ShieldCheck size={22} />
              <h3>You approve every action</h3>
              <p>Automoteev never contacts a provider without your explicit approval, especially in the first few interactions. Autonomy unlocks gradually as you build trust with the agent.</p>
            </div>
            <div className="trust-card">
              <Lock size={22} />
              <h3>Phone numbers stay private</h3>
              <p>Outbound emails go from your dedicated Automoteev alias. Your phone number is never disclosed in agent communication.</p>
            </div>
            <div className="trust-card">
              <Info size={22} />
              <h3>Every action is logged</h3>
              <p>The agent's full activity trail — every email sent, every reply received, every contact learned — is reviewable in your account.</p>
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="landing-final-cta">
          <h2>Ready to stop overpaying?</h2>
          <p className="landing-section-sub">Sign up in under a minute. VIN and mileage to start.</p>
          <Link to="/signup" className="primary big-cta">Get started — free</Link>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

// Stylized faux product card. Stays in sync with brand without needing a real screenshot.
function ProductPreviewCard() {
  return (
    <div className="preview-card">
      <div className="preview-head">
        <div className="preview-pill">Action recommended</div>
      </div>
      <h3 className="preview-vehicle">2020 Land Rover Range Rover</h3>
      <p className="preview-vin small muted">VIN xxxx...LA584256 · 47,000 mi</p>
      <div className="preview-savings">
        <TrendingUp size={18} />
        <strong>~$4,962/yr in potential savings</strong>
      </div>
      <div className="preview-priority">
        <div className="preview-priority-row preview-urgent">
          <AlertTriangle size={14} />
          <span><strong>4 open recalls</strong> · Approve &amp; contact dealers</span>
        </div>
        <div className="preview-priority-row preview-rec">
          <DollarSign size={14} />
          <span><strong>Refinancing could save ~$4,662/yr</strong></span>
        </div>
        <div className="preview-priority-row preview-rec">
          <DollarSign size={14} />
          <span><strong>Insurance shopping: ~$300/yr</strong></span>
        </div>
      </div>
    </div>
  );
}

function SignInPage() {
  return (
    <div className="public-page">
      <PublicNav />
      <main className="auth-page-main">
        <div className="auth-page-grid">
          <div className="auth-page-intro">
            <h1>Welcome back</h1>
            <p className="muted">
              Sign in to your Automoteev account to see what the agent has been working on.
            </p>
          </div>
          <SignInForm />
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="public-page">
      <PublicNav />
      <main className="auth-page-main">
        <div className="auth-page-grid">
          <div className="auth-page-intro">
            <h1>Get started</h1>
            <p className="muted">
              Free to sign up. We just need an email and password to get going — you'll add
              your vehicle on the next step.
            </p>
            <div className="trust-row small">
              <ShieldCheck size={14} /> Nothing gets sent to a provider without your approval.
            </div>
          </div>
          <SignUpForm />
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

function PrivacyPage() {
  return (
    <div className="public-page">
      <PublicNav />
      <main className="legal-main">
        <div className="legal-content">
          <h1>Privacy Policy</h1>
          <p className="muted small">Last updated: April 2026</p>
          <p>
            Automoteev ("we", "us") is operated by Carculus Automotive LLC. This policy
            describes what information we collect, how we use it, and the choices you have.
          </p>

          <h2>What we collect</h2>
          <ul>
            <li><strong>Account info:</strong> name, email, ZIP code, optional phone.</li>
            <li><strong>Vehicle info:</strong> VIN, mileage, ownership type, insurance carrier, loan/lease terms, recall status.</li>
            <li><strong>Documents you upload:</strong> insurance dec pages, loan statements. Used only to extract structured fields you can apply to your profile.</li>
            <li><strong>Activity:</strong> tasks you create, providers you approve, emails the agent sends and receives on your behalf.</li>
          </ul>

          <h2>What we don't sell</h2>
          <p>
            We do not sell your personal information. We do not provide your data to third
            parties for their own marketing. The only third parties that receive any of your
            information are the providers you explicitly approve the agent to contact — and
            only the fields you authorize for that interaction.
          </p>

          <h2>How the agent communicates</h2>
          <p>
            Outbound emails are sent from a dedicated Automoteev alias on your behalf. Provider
            replies route back into your Automoteev account, not directly to your personal
            inbox. Your phone number is never disclosed in outbound agent communication.
          </p>

          <h2>Your choices</h2>
          <ul>
            <li>You can delete your account at any time by emailing gerry@carculus.ai.</li>
            <li>You can revoke autonomy and require manual approval for every outbound action.</li>
            <li>You can request a copy of your data.</li>
          </ul>

          <h2>Contact</h2>
          <p>
            Questions? Email <a href="mailto:gerry@carculus.ai">gerry@carculus.ai</a>.
          </p>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

function TermsPage() {
  return (
    <div className="public-page">
      <PublicNav />
      <main className="legal-main">
        <div className="legal-content">
          <h1>Terms of Service</h1>
          <p className="muted small">Last updated: April 2026</p>
          <p>
            By using Automoteev (operated by Carculus Automotive LLC), you agree to these
            terms. Read them carefully before creating an account.
          </p>

          <h2>What Automoteev does</h2>
          <p>
            Automoteev is an AI agent that helps you manage recurring expenses on your
            vehicle and other financial commitments. The agent surfaces recommendations,
            drafts communication with third-party providers, and (with your approval)
            sends emails on your behalf.
          </p>

          <h2>Your authorization</h2>
          <p>
            You authorize Automoteev to contact providers using your dedicated agent email
            alias, only after you explicitly approve each action (or category of actions, in
            higher autonomy levels). You can revoke this authorization at any time from your
            account settings.
          </p>

          <h2>What Automoteev is not</h2>
          <ul>
            <li>Automoteev is not a licensed insurance agent or producer. We facilitate quote requests on your behalf but do not bind coverage.</li>
            <li>Automoteev is not a financial advisor or lender. Refinance and payoff information is provided for your reference; final terms come from the lender.</li>
            <li>Automoteev is not a tax advisor.</li>
          </ul>

          <h2>Pro subscription</h2>
          <p>
            Pro features (autonomous agent outreach, document upload, multi-vehicle, etc.)
            are billed at $9.99/month or $99/year via Stripe. You can cancel any time; access
            continues through the end of the current billing period.
          </p>

          <h2>Limitation of liability</h2>
          <p>
            Automoteev provides recommendations and facilitates communication. You are
            responsible for the final decisions on services, financial products, and any
            agreements you enter with third-party providers. Carculus Automotive LLC's
            liability is limited to the amount you have paid for the service in the prior
            twelve months.
          </p>

          <h2>Contact</h2>
          <p>
            Questions? Email <a href="mailto:gerry@carculus.ai">gerry@carculus.ai</a>.
          </p>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

// ============================================================
// AuthenticatedApp — the signed-in product surface (formerly Product)
// ============================================================
function AuthenticatedApp() {
  const { session } = useSession();
  if (!session) return null; // RequireAuth guards this; defensive null.
  return <Product session={session} />;
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
  const [dispatch, setDispatch] = useState<DispatchPayload | null>(null);
  const [openingDispatchTaskId, setOpeningDispatchTaskId] = useState<string | null>(null);
  // When the user clicks "see sent email" on the recall card while outreach is
  // in flight, we switch to the History tab and auto-expand the relevant task
  // so they see the email thread immediately instead of having to hunt for it.
  const [historyAutoExpandTaskId, setHistoryAutoExpandTaskId] = useState<string | null>(null);
  // Just-in-time DL collection: when an insurance dispatch requires a DL we
  // hold the pending dispatch payload here and show DLPromptModal first. After
  // the user saves their DL we re-fetch the dispatch preview (now requires_dl=false)
  // and open the regular DispatchModal.
  const [pendingInsuranceDispatch, setPendingInsuranceDispatch] = useState<DispatchPayload | null>(null);

  function viewSentEmail(taskId: string) {
    setHistoryAutoExpandTaskId(taskId);
    setTab("history");
  }

  /**
   * Open the DispatchModal for an existing task. Used when the user clicks
   * "Approve & contact dealers" on a dispatchable task card. Hits the
   * /dispatch-preview endpoint which re-runs discovery + drafts the email.
   *
   * If the task is insurance and requires a DL, we route to the DL prompt
   * first. After DL is saved, this function is called again and the second
   * preview will return requires_dl=false.
   */
  async function openDispatchForTask(taskId: string) {
    setOpeningDispatchTaskId(taskId);
    try {
      const result = await api<{
        action: string;
        task: Task;
        providers: DispatchProvider[];
        preferred_provider_id: string | null;
        email_preview: { subject: string; body: string };
        requires_dl?: boolean;
      }>(`/api/tasks/${taskId}/dispatch-preview`);
      const payload: DispatchPayload = {
        task: result.task,
        providers: result.providers,
        preferred_provider_id: result.preferred_provider_id,
        email_preview: result.email_preview,
        requires_dl: result.requires_dl
      };
      if (result.requires_dl) {
        setPendingInsuranceDispatch(payload);
      } else {
        setDispatch(payload);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open dispatch.");
    } finally {
      setOpeningDispatchTaskId(null);
    }
  }

  /** Called by DLPromptModal after user saves DL. Re-fetch + open dispatch. */
  async function onDlCollected() {
    const pending = pendingInsuranceDispatch;
    setPendingInsuranceDispatch(null);
    if (pending) {
      await openDispatchForTask(pending.task.id);
    }
  }

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
        providers?: DispatchProvider[];
        preferred_provider_id?: string | null;
        email_preview?: { subject: string; body: string };
        already_existed?: boolean;
      }>("/api/insights/act", {
        method: "POST",
        body: JSON.stringify({ insight_key: insight.key, vehicle_id: selectedId })
      });

      if (result.action === "open_dispatch" && result.task && result.providers && result.email_preview) {
        const payload: DispatchPayload = {
          task: result.task,
          providers: result.providers,
          preferred_provider_id: result.preferred_provider_id ?? null,
          email_preview: result.email_preview,
          already_existed: result.already_existed,
          requires_dl: (result as any).requires_dl
        };
        if ((result as any).requires_dl) {
          setPendingInsuranceDispatch(payload);
        } else {
          setDispatch(payload);
        }
      } else if (result.action === "task_created" && result.task) {
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

  // Deep-link from a push notification: when the user taps a "dealer replied"
  // notification, the service worker opens /app?tab=history&task=<id>. We
  // parse those params on mount, switch to the right tab, expand the task,
  // then strip the params so a refresh doesn't re-trigger the deep-link.
  useEffect(() => {
    const applyDeepLink = (rawUrl: string) => {
      try {
        const url = new URL(rawUrl, window.location.origin);
        const requestedTab = url.searchParams.get("tab");
        const requestedTask = url.searchParams.get("task");
        if (requestedTab === "history") {
          setTab("history");
          if (requestedTask) setHistoryAutoExpandTaskId(requestedTask);
          // Clean up the URL so future renders don't keep applying the deep-link.
          window.history.replaceState({}, "", "/app");
        }
      } catch {
        // Malformed URL — ignore.
      }
    };

    // 1. On mount, apply any params already in the address bar (works when
    //    the SW just navigated this tab or when the app was opened fresh).
    applyDeepLink(window.location.href);

    // 2. Listen for service worker postMessages — covers the case where the
    //    tab was already open at /app and SW navigation didn't re-mount React.
    const onSwMessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg && msg.type === "automoteev:deep-link" && typeof msg.url === "string") {
        applyDeepLink(msg.url);
      }
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
    }
    return () => {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onSwMessage);
      }
    };
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
          <div className="muted small">Your AI agent for life's recurring expenses</div>
        </div>
        <div className="topbar-right">
          <nav className="tabs desktop-only" aria-label="Main">
            {(["status", "tasks", "command", "history", "settings"] as Tab[]).map((item) => (
              <button className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)}>
                {item}
              </button>
            ))}
          </nav>
          <button
            className="signout-btn"
            onClick={() => supabase.auth.signOut()}
            aria-label="Sign out"
            title={session.user.email ?? "Sign out"}
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
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

      {dispatch && (
        <DispatchModal
          payload={dispatch}
          onClose={() => setDispatch(null)}
          onSent={async () => {
            setDispatch(null);
            setTab("tasks");
            await refresh();
          }}
        />
      )}

      {pendingInsuranceDispatch && (
        <DLPromptModal
          onClose={() => setPendingInsuranceDispatch(null)}
          onSaved={onDlCollected}
        />
      )}

      {tab === "status" && dashboard && selectedId && (
        <Status
          dashboard={dashboard}
          vehicleId={selectedId}
          tasks={tasks}
          onRefresh={refresh}
          onActOnInsight={actOnInsight}
          actBusyKey={actBusyKey}
          onOpenDispatch={openDispatchForTask}
          openingDispatchTaskId={openingDispatchTaskId}
          onViewSentEmail={viewSentEmail}
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
          onOpenDispatch={openDispatchForTask}
          openingDispatchTaskId={openingDispatchTaskId}
        />
      )}
      {tab === "command" && selectedId && <Command vehicleId={selectedId} onCreated={refresh} />}
      {tab === "history" && <History tasks={tasks} autoExpandTaskId={historyAutoExpandTaskId} />}
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
  tasks,
  onRefresh,
  onActOnInsight,
  actBusyKey,
  onOpenDispatch,
  openingDispatchTaskId,
  onViewSentEmail
}: {
  dashboard: Dashboard;
  vehicleId: string;
  tasks: Task[];
  onRefresh: () => void;
  onActOnInsight: (insight: Insight) => void;
  actBusyKey: string | null;
  onOpenDispatch: (taskId: string) => void;
  openingDispatchTaskId: string | null;
  onViewSentEmail: (taskId: string) => void;
}) {
  const status = dashboard.vehicle.overall_status;
  const statusColor = status === "all_good" ? "green" : status === "action_needed" ? "red" : "yellow";
  const statusText = status === "all_good" ? "All good" : status === "action_needed" ? "Action needed" : "Action recommended";
  const totalSavings = dashboard.total_estimated_annual_savings_usd;

  // Priority actions = recalls (always urgent) + urgent insights + recommended insights.
  // Info-level insights are deprioritized to the bottom panel so the top stays focused
  // on things that actually need the owner to act.
  const urgentInsights = dashboard.insights.filter((i) => i.severity === "urgent");
  const recommendedInsights = dashboard.insights.filter((i) => i.severity === "recommended");
  const infoInsights = dashboard.insights.filter((i) => i.severity === "info");
  const hasRecalls = dashboard.open_recalls.length > 0;
  const hasPriority = hasRecalls || urgentInsights.length > 0 || recommendedInsights.length > 0;

  // Find any active recall_repair task so the recall card can show its current
  // state (awaiting approval vs dispatched and waiting on dealer reply) instead
  // of always shouting "act soon" when outreach has already gone out.
  const activeRecallTask = tasks.find(
    (t) =>
      t.task_type === "recall_repair" &&
      ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"].includes(t.status)
  ) ?? null;

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

        {hasPriority && (
          <PriorityActions
            recalls={dashboard.open_recalls}
            urgentInsights={urgentInsights}
            recommendedInsights={recommendedInsights}
            activeRecallTask={activeRecallTask}
            onActOnInsight={onActOnInsight}
            actBusyKey={actBusyKey}
            onOpenDispatch={onOpenDispatch}
            openingDispatchTaskId={openingDispatchTaskId}
            onViewSentEmail={onViewSentEmail}
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

        {dashboard.maintenance_items.length > 0 && <MaintenanceList items={dashboard.maintenance_items} />}

        <DocumentDropZone vehicleId={vehicleId} onComplete={onRefresh} />
      </div>

      <aside className="side-panel">
        {infoInsights.length > 0 && (
          <ImprovementsPanel
            insights={infoInsights}
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

// ============================================================
// PRIORITY ACTIONS — top-of-page color-coded urgency panel.
// Combines open recalls (always urgent), urgent insights, and recommended
// insights into a single panel. The user sees what to do, in priority order,
// before scrolling to anything else.
// ============================================================
function PriorityActions({
  recalls,
  urgentInsights,
  recommendedInsights,
  activeRecallTask,
  onActOnInsight,
  actBusyKey,
  onOpenDispatch,
  openingDispatchTaskId,
  onViewSentEmail
}: {
  recalls: RecallRecord[];
  urgentInsights: Insight[];
  recommendedInsights: Insight[];
  activeRecallTask: Task | null;
  onActOnInsight: (insight: Insight) => void;
  actBusyKey: string | null;
  onOpenDispatch: (taskId: string) => void;
  openingDispatchTaskId: string | null;
  onViewSentEmail: (taskId: string) => void;
}) {
  // If we're already showing the recall card, fold its CTA into the card and
  // suppress the standalone recall_repair insight row — otherwise the user sees
  // two cards stacked saying the same thing.
  const recallInsight = urgentInsights.find(
    (i) => i.action.type === "create_task" && i.action.task_type === "recall_repair"
  );
  const otherUrgentInsights = urgentInsights.filter(
    (i) => !(i.action.type === "create_task" && i.action.task_type === "recall_repair")
  );

  // Recall card placement depends on task state:
  //   - No task / needs_user_approval / approved → urgent (red), shows CTA
  //   - in_progress / waiting_on_provider          → recommended (yellow), shrunk, status-only
  //   The user shouldn't see "Urgent — act soon" once the agent is already on it.
  const recallTaskInFlight =
    activeRecallTask?.status === "in_progress" ||
    activeRecallTask?.status === "waiting_on_provider";
  const recallInUrgent = recalls.length > 0 && !recallTaskInFlight;
  const recallInRecommended = recalls.length > 0 && recallTaskInFlight;

  const hasUrgent = recallInUrgent || otherUrgentInsights.length > 0;
  const hasRecommended = recallInRecommended || recommendedInsights.length > 0;

  return (
    <div className="priority-actions">
      {hasUrgent && (
        <section className="priority-section priority-urgent">
          <div className="priority-section-head">
            <AlertTriangle size={18} />
            <strong>Urgent — act soon</strong>
          </div>
          {recallInUrgent && (
            <PriorityRecallCard
              recalls={recalls}
              insight={recallInsight}
              activeTask={activeRecallTask}
              onAct={() => recallInsight && onActOnInsight(recallInsight)}
              onOpenDispatch={onOpenDispatch}
              onViewSentEmail={onViewSentEmail}
              busy={
                Boolean(recallInsight && actBusyKey === recallInsight.key) ||
                Boolean(activeRecallTask && openingDispatchTaskId === activeRecallTask.id)
              }
            />
          )}
          {otherUrgentInsights.map((i) => (
            <PriorityInsightRow
              key={i.key}
              insight={i}
              tone="urgent"
              onAct={() => onActOnInsight(i)}
              busy={actBusyKey === i.key}
            />
          ))}
        </section>
      )}

      {hasRecommended && (
        <section className="priority-section priority-recommended">
          <div className="priority-section-head">
            <Sparkles size={18} />
            <strong>Recommended — savings &amp; improvements</strong>
          </div>
          {recallInRecommended && (
            <PriorityRecallCard
              recalls={recalls}
              insight={undefined}
              activeTask={activeRecallTask}
              onAct={() => undefined}
              onOpenDispatch={onOpenDispatch}
              onViewSentEmail={onViewSentEmail}
              busy={Boolean(activeRecallTask && openingDispatchTaskId === activeRecallTask.id)}
              shrunk
            />
          )}
          {recommendedInsights.map((i) => (
            <PriorityInsightRow
              key={i.key}
              insight={i}
              tone="recommended"
              onAct={() => onActOnInsight(i)}
              busy={actBusyKey === i.key}
            />
          ))}
        </section>
      )}
    </div>
  );
}

// Single "open recalls" card inside the urgent section. The actual list of
// recalls renders as expandable details rows underneath the header so the user
// can dig into specifics without leaving the priority panel.
function PriorityRecallCard({
  recalls,
  insight,
  activeTask,
  onAct,
  onOpenDispatch,
  onViewSentEmail,
  busy,
  shrunk
}: {
  recalls: RecallRecord[];
  insight: Insight | undefined;
  activeTask: Task | null;
  onAct: () => void;
  onOpenDispatch: (taskId: string) => void;
  onViewSentEmail: (taskId: string) => void;
  busy: boolean;
  shrunk?: boolean;
}) {
  // In-flight = outreach has been sent, waiting on dealer reply.
  const inFlight =
    activeTask?.status === "waiting_on_provider" ||
    activeTask?.status === "in_progress";
  // Approved-but-not-dispatched = legacy stuck state where someone hit Approve
  // without going through the modal. We surface a Contact dealers button.
  const approvedAwaitingDispatch =
    activeTask?.status === "approved" && !inFlight;

  return (
    <div className={`priority-recall-card ${shrunk ? "shrunk" : ""}`}>
      <div className="priority-recall-head">
        <div>
          <strong>{recalls.length} open recall{recalls.length === 1 ? "" : "s"} on your vehicle</strong>
          {inFlight ? (
            <p className="small recall-inflight-note">
              <Send size={12} /> Outreach sent — waiting for the dealer to reply.{" "}
              {activeTask && (
                <>
                  <button
                    className="ghost small inline-edit"
                    type="button"
                    onClick={() => onViewSentEmail(activeTask.id)}
                  >
                    see what was sent
                  </button>
                  {" · "}
                  <button
                    className="ghost small inline-edit"
                    type="button"
                    onClick={() => onOpenDispatch(activeTask.id)}
                    disabled={busy}
                  >
                    contact more dealers
                  </button>
                </>
              )}
            </p>
          ) : (
            <p className="small muted">
              Recall repairs are free at any authorized dealer. Tap a row for what's affected.
            </p>
          )}
        </div>
        {/* CTA logic:
           - inFlight: no CTA, status text replaces it
           - has insight (no active task or approval-state): "Approve & contact dealers"
           - approved-but-stuck: "Contact dealers" (recover from legacy stuck state) */}
        {!inFlight && insight && (
          <button className="primary recall-cta" type="button" onClick={onAct} disabled={busy}>
            {busy ? (
              <><Loader2 size={16} className="spinner" /> Finding dealers…</>
            ) : (
              <>{insight.cta_label} <ChevronRight size={14} /></>
            )}
          </button>
        )}
        {!inFlight && !insight && approvedAwaitingDispatch && activeTask && (
          <button
            className="primary recall-cta"
            type="button"
            onClick={() => onOpenDispatch(activeTask.id)}
            disabled={busy}
          >
            {busy ? (
              <><Loader2 size={16} className="spinner" /> Loading…</>
            ) : (
              <><Send size={14} /> Contact dealers</>
            )}
          </button>
        )}
      </div>
      {recalls.map((r) => (
        <details className="recall-item" key={r.id}>
          <summary>
            <AlertTriangle size={16} className="recall-icon" />
            <div className="recall-summary-text">
              <strong>{r.component ?? "Recall campaign"}</strong>
              <span className="muted small">Campaign #{r.nhtsa_campaign_id}</span>
            </div>
            <ChevronRight size={16} className="recall-chev" />
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

function PriorityInsightRow({
  insight,
  tone,
  onAct,
  busy
}: {
  insight: Insight;
  tone: "urgent" | "recommended";
  onAct: () => void;
  busy: boolean;
}) {
  return (
    <button
      className={`priority-insight-row priority-row-${tone}`}
      onClick={onAct}
      disabled={busy}
      type="button"
    >
      <div className="priority-row-icon">
        {busy ? <Loader2 size={18} className="spinner" /> :
          tone === "urgent" ? <AlertTriangle size={18} /> :
          insight.category === "insurance" || insight.category === "lending" ? <DollarSign size={18} /> :
          <Sparkles size={18} />}
      </div>
      <div className="priority-row-body">
        <div className="priority-row-title">{insight.title}</div>
        <div className="priority-row-text small">{insight.body}</div>
        {insight.estimated_savings_usd_per_year ? (
          <div className="priority-row-savings">~${insight.estimated_savings_usd_per_year}/yr potential savings</div>
        ) : null}
      </div>
      <div className="priority-row-cta">
        {busy ? "Working…" : insight.cta_label} <ChevronRight size={14} />
      </div>
    </button>
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
  onRefresh,
  onOpenDispatch,
  openingDispatchTaskId
}: {
  dashboard: Dashboard;
  tasks: Task[];
  providers: Provider[];
  autonomy: AutonomyStatus | null;
  highlightTaskId: string | null;
  onActOnInsight: (i: Insight) => void;
  actBusyKey: string | null;
  onRefresh: () => void;
  onOpenDispatch: (taskId: string) => void;
  openingDispatchTaskId: string | null;
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
          groups.active.map((task) => {
            const dispatchable = isDispatchableTaskType(task.task_type);
            const opening = openingDispatchTaskId === task.id;
            return (
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

                {/* needs_user_approval: dispatchable tasks open the DispatchModal,
                    everything else uses the simple Approve/Cancel two-tap path. */}
                {task.status === "needs_user_approval" && dispatchable && (
                  <div className="button-row">
                    <button
                      className="primary"
                      onClick={() => onOpenDispatch(task.id)}
                      disabled={opening}
                    >
                      {opening ? (
                        <><Loader2 size={16} className="spinner" /> Finding dealers…</>
                      ) : (
                        <><Send size={16} /> Approve &amp; contact dealers</>
                      )}
                    </button>
                    <button className="ghost" onClick={() => approve(task, false)} disabled={opening}>Cancel</button>
                  </div>
                )}
                {task.status === "needs_user_approval" && !dispatchable && (
                  <div className="button-row">
                    <button className="primary" onClick={() => approve(task, true)}>Approve</button>
                    <button className="ghost" onClick={() => approve(task, false)}>Cancel</button>
                  </div>
                )}

                {/* approved + dispatchable: surface a "contact dealers" CTA so users
                    aren't stranded if they hit Approve via an older code path. */}
                {task.status === "approved" && dispatchable && (
                  <div className="button-row">
                    <button
                      className="primary"
                      onClick={() => onOpenDispatch(task.id)}
                      disabled={opening}
                    >
                      {opening ? (
                        <><Loader2 size={16} className="spinner" /> Finding dealers…</>
                      ) : (
                        <><Send size={16} /> Contact dealers</>
                      )}
                    </button>
                  </div>
                )}

                {/* waiting_on_provider: outreach already went out. Let the user
                    contact additional providers without being stranded. */}
                {task.status === "waiting_on_provider" && dispatchable && (
                  <div className="button-row">
                    <button
                      className="secondary"
                      onClick={() => onOpenDispatch(task.id)}
                      disabled={opening}
                    >
                      {opening ? (
                        <><Loader2 size={16} className="spinner" /> Finding more…</>
                      ) : (
                        <><Send size={16} /> Contact more dealers</>
                      )}
                    </button>
                  </div>
                )}
              </article>
            );
          })
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
// DISPATCH MODAL (review email + pick dealers + send)
// ============================================================
function DispatchModal({
  payload,
  onClose,
  onSent
}: {
  payload: DispatchPayload;
  onClose: () => void;
  onSent: () => void;
}) {
  const initialSelected = new Set(
    payload.providers.filter((p) => Boolean(p.email)).map((p) => p.id)
  );
  const [selected, setSelected] = useState<Set<string>>(initialSelected);
  const [preferredId, setPreferredId] = useState<string | null>(
    payload.preferred_provider_id ?? null
  );
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [emailOverrides, setEmailOverrides] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEmailBody, setShowEmailBody] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const ids = Array.from(selected);
      const overrides: Record<string, { email: string }> = {};
      for (const [id, email] of Object.entries(emailOverrides)) {
        if (email && selected.has(id)) overrides[id] = { email };
      }
      const result = await api<{ sent: number; skipped: any[] }>(
        `/api/tasks/${payload.task.id}/dispatch`,
        {
          method: "POST",
          body: JSON.stringify({
            provider_ids: ids,
            preferred_id: preferredId,
            ...(Object.keys(overrides).length ? { overrides } : {})
          })
        }
      );
      if (result.sent === 0) {
        setError("No emails were sent. Check that selected providers have valid email addresses.");
        setBusy(false);
        return;
      }
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dispatch failed.");
      setBusy(false);
    }
  }

  const sendableCount = Array.from(selected).filter((id) => {
    const p = payload.providers.find((x) => x.id === id);
    if (!p) return false;
    const overridden = emailOverrides[id];
    return Boolean(overridden ?? p.email);
  }).length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dispatch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Reach out to dealers</h2>
          <button className="ghost icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <p className="small muted">
          Automoteev only emails dealers with a verified contact address found on their
          website. Dealers without a published email show their phone and website so you
          can reach out directly. Pick which dealer becomes your preferred for next time.
        </p>

        {/* Email preview */}
        <div className="email-preview">
          <div className="email-preview-head">
            <Mail size={16} />
            <strong>Subject:</strong> <span>{payload.email_preview.subject}</span>
          </div>
          <button
            className="ghost small"
            type="button"
            onClick={() => setShowEmailBody((v) => !v)}
          >
            {showEmailBody ? "Hide email" : "Show full email"}
          </button>
          {showEmailBody && (
            <pre className="email-body">{payload.email_preview.body}</pre>
          )}
        </div>

        {/* Dealer list */}
        <div className="dealer-list">
          <div className="dealer-list-head">
            <strong>Dealers found ({payload.providers.length})</strong>
            <span className="small muted">Tap a row to include or skip</span>
          </div>
          {payload.providers.length === 0 && (
            <p className="muted small">
              No dealers found near your ZIP. Add one manually under Tasks → Provider outreach.
            </p>
          )}
          {payload.providers.map((p) => {
            const overrideEmail = emailOverrides[p.id];
            const effectiveEmail = overrideEmail ?? p.email;
            const hasEmail = Boolean(effectiveEmail);
            const isSelected = selected.has(p.id) && hasEmail;
            const isPreferred = preferredId === p.id;
            return (
              <div
                key={p.id}
                className={`dealer-row ${isSelected ? "selected" : ""} ${isPreferred ? "preferred" : ""} ${!hasEmail ? "no-email" : ""}`}
              >
                {hasEmail ? (
                  <button
                    type="button"
                    className="dealer-toggle"
                    onClick={() => toggle(p.id)}
                    aria-pressed={isSelected}
                    aria-label="Toggle send to this dealer"
                  >
                    <span className={`checkbox ${isSelected ? "checked" : ""}`}>
                      {isSelected && <CheckCircle2 size={14} />}
                    </span>
                  </button>
                ) : (
                  <span className="dealer-toggle dealer-toggle-disabled" aria-hidden>
                    <Phone size={16} />
                  </span>
                )}
                <div className="dealer-info">
                  <div className="dealer-name">
                    <strong>{p.name}</strong>
                    {p.distance_miles != null && (
                      <span className="dealer-distance" title="Distance from your ZIP">
                        <MapPin size={12} /> {formatDistance(p.distance_miles)}
                      </span>
                    )}
                    {p.rating != null && (
                      <span className="dealer-rating">
                        <Star size={12} /> {p.rating.toFixed(1)}
                        {p.rating_count != null && (
                          <span className="muted"> ({p.rating_count})</span>
                        )}
                      </span>
                    )}
                    {!hasEmail && (
                      <span className="phone-only-badge" title="No verified email — reach out by phone or website">
                        Phone / website only
                      </span>
                    )}
                  </div>
                  {p.location && (
                    <div className="dealer-meta">
                      <MapPin size={12} /> <span className="small muted">{p.location}</span>
                    </div>
                  )}
                  {p.phone && (
                    <div className="dealer-meta">
                      <Phone size={12} />{" "}
                      <a href={`tel:${p.phone}`} className="small">{p.phone}</a>
                    </div>
                  )}
                  <div className="dealer-meta dealer-email-row">
                    <Mail size={12} />
                    {editingEmailId === p.id ? (
                      <input
                        autoFocus
                        type="email"
                        defaultValue={effectiveEmail ?? ""}
                        className="dealer-email-input"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v) {
                            setEmailOverrides((prev) => ({ ...prev, [p.id]: v }));
                            // Auto-select once an email is added.
                            setSelected((prev) => new Set(prev).add(p.id));
                          }
                          setEditingEmailId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                          } else if (e.key === "Escape") {
                            setEditingEmailId(null);
                          }
                        }}
                      />
                    ) : effectiveEmail ? (
                      <span className="small">
                        {effectiveEmail}
                        <button
                          className="ghost small inline-edit"
                          type="button"
                          onClick={() => setEditingEmailId(p.id)}
                        >
                          edit
                        </button>
                      </span>
                    ) : (
                      <span className="small muted">
                        no published email —
                        <button
                          className="ghost small inline-edit"
                          type="button"
                          onClick={() => setEditingEmailId(p.id)}
                        >
                          add one manually
                        </button>
                      </span>
                    )}
                  </div>
                  {p.website && (
                    <div className="dealer-meta">
                      <ExternalLink size={12} />{" "}
                      <a href={p.website} target="_blank" rel="noreferrer" className="small">
                        Visit website
                      </a>
                    </div>
                  )}
                  <label className="preferred-radio small">
                    <input
                      type="radio"
                      name="preferred"
                      checked={isPreferred}
                      onChange={() => setPreferredId(p.id)}
                    />
                    Set as my preferred dealer
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {error && <div className="error">{error}</div>}

        <div className="button-row dispatch-actions">
          <button
            className="primary"
            type="button"
            onClick={send}
            disabled={busy || sendableCount === 0}
          >
            {busy ? (
              <><Loader2 size={16} className="spinner" /> Sending…</>
            ) : (
              <><Send size={16} /> Send to {sendableCount} dealer{sendableCount === 1 ? "" : "s"}</>
            )}
          </button>
          <button className="ghost" type="button" onClick={onClose} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// DL PROMPT MODAL (just-in-time DL collection for insurance)
// ============================================================
//
// Shown right before the insurance dispatch modal when the user has not yet
// provided a driver's license. Insurance carriers cannot generate a real
// quote without a DL number + state, so collecting it here saves a round-trip
// where the dealer would email back asking for it.
//
// On save, we PUT /api/pii with the DL fields (encrypted server-side) and
// invoke onSaved which re-fetches the dispatch-preview (now with
// requires_dl=false) and opens the regular DispatchModal.
function DLPromptModal({
  onClose,
  onSaved
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [dlNumber, setDlNumber] = useState("");
  const [dlState, setDlState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    if (!dlNumber.trim() || dlState.trim().length !== 2) {
      setError("Enter your DL number and 2-letter state.");
      return;
    }
    setBusy(true);
    try {
      await api("/api/pii", {
        method: "PUT",
        body: JSON.stringify({
          dl_number: dlNumber.trim(),
          dl_state: dlState.trim().toUpperCase()
        })
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save DL.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal dl-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>One quick thing before quotes go out</h2>
          <button className="ghost icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="small">
          Insurance carriers can't generate a real quote without your driver's
          license. We store this encrypted on the server and only share it with
          carriers you explicitly approve when they request it for a quote.
        </p>

        <div className="trust-row small dl-trust-row">
          <Lock size={14} /> Encrypted at rest. Only sent to a specific carrier
          after you approve that carrier.
        </div>

        <div className="form-grid">
          <Field
            label="Driver's license number"
            value={dlNumber}
            onChange={setDlNumber}
            required
            placeholder="e.g. C1234567"
          />
          <label>State of issue
            <select value={dlState} onChange={(e) => setDlState(e.target.value)}>
              <option value="">—</option>
              {US_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="button-row">
          <button className="primary" type="button" onClick={save} disabled={busy}>
            {busy ? (
              <><Loader2 size={16} className="spinner" /> Saving…</>
            ) : (
              <><CheckCircle2 size={16} /> Save and continue</>
            )}
          </button>
          <button className="ghost" type="button" onClick={onClose} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC"
];

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
// HISTORY TAB — expandable activity log per task.
// Each task (active + closed) is expandable to show its full email thread
// and audit trail. Backed by /api/tasks/:id/history which returns
// { emails, audit_logs }. Closed tasks grouped by status; active tasks at top.
// ============================================================
function History({ tasks, autoExpandTaskId }: { tasks: Task[]; autoExpandTaskId?: string | null }) {
  const active = tasks.filter((t) => !(["completed", "failed", "cancelled"].includes(t.status)));
  const closed = tasks.filter((t) => ["completed", "failed", "cancelled"].includes(t.status));
  const grouped = {
    active,
    completed: closed.filter((t) => t.status === "completed"),
    cancelled: closed.filter((t) => t.status === "cancelled"),
    failed: closed.filter((t) => t.status === "failed")
  };

  return (
    <section className="history-page">
      <div className="panel">
        <h2>Activity log</h2>
        <p className="muted small">
          Every Automoteev action is logged here. Tap any task to see the email
          thread, who replied, and what the agent learned.
        </p>
        {tasks.length === 0 ? (
          <p className="muted">Nothing here yet. Approved and finished tasks will show up here.</p>
        ) : (
          <>
            <HistoryGroup title="In progress" tasks={grouped.active} expandable autoExpandTaskId={autoExpandTaskId} />
            <HistoryGroup title="Completed" tasks={grouped.completed} expandable autoExpandTaskId={autoExpandTaskId} />
            <HistoryGroup title="Cancelled" tasks={grouped.cancelled} expandable autoExpandTaskId={autoExpandTaskId} />
            <HistoryGroup title="Did not complete" tasks={grouped.failed} subtle expandable autoExpandTaskId={autoExpandTaskId} />
          </>
        )}
      </div>
    </section>
  );
}

interface TaskHistoryEmail {
  id: string;
  direction: "outbound" | "inbound";
  to_email: string;
  from_email: string;
  subject: string;
  body_text: string;
  status: string;
  created_at: string;
}

interface TaskHistoryAuditLog {
  id: string;
  event_type: string;
  summary: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface TaskHistoryResponse {
  emails: TaskHistoryEmail[];
  audit_logs: TaskHistoryAuditLog[];
}

function HistoryGroup({
  title,
  tasks,
  subtle,
  expandable,
  autoExpandTaskId
}: {
  title: string;
  tasks: Task[];
  subtle?: boolean;
  expandable?: boolean;
  autoExpandTaskId?: string | null;
}) {
  if (!tasks.length) return null;
  return (
    <div className={`history-group ${subtle ? "subtle" : ""}`}>
      <h3>{title} <span className="muted small" style={{ fontWeight: 400, textTransform: "none" }}>({tasks.length})</span></h3>
      <div className="history-list">
        {tasks.map((t) =>
          expandable ? (
            <HistoryTaskRow
              key={t.id}
              task={t}
              autoExpand={autoExpandTaskId === t.id}
            />
          ) : (
            <div className="history-row" key={t.id}>
              <span className="history-title">{t.title}</span>
              <span className="muted small">{new Date(t.created_at).toLocaleDateString()}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function HistoryTaskRow({ task, autoExpand }: { task: Task; autoExpand?: boolean }) {
  const [open, setOpen] = useState(Boolean(autoExpand));
  const [history, setHistory] = useState<TaskHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  async function loadHistory() {
    if (history || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<TaskHistoryResponse>(`/api/tasks/${task.id}/history`);
      setHistory(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history");
    } finally {
      setLoading(false);
    }
  }

  // Auto-expand on mount when the deep-link prop matches this task. Also scroll
  // it into view so the user lands directly on the email thread they came to see.
  useEffect(() => {
    if (autoExpand) {
      setOpen(true);
      void loadHistory();
      requestAnimationFrame(() => {
        rowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExpand]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) await loadHistory();
  }

  return (
    <div className="history-task" ref={rowRef}>
      <button className="history-task-head" type="button" onClick={toggle}>
        <ChevronRight
          size={16}
          className="history-task-chev"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        />
        <div className="history-task-head-text">
          <span className="history-title">{task.title}</span>
          <span className="muted small">
            {new Date(task.created_at).toLocaleDateString()} · {task.status.replaceAll("_", " ")}
          </span>
        </div>
        <span className={`status-chip status-${task.status}`}>
          {task.status.replaceAll("_", " ")}
        </span>
      </button>
      {open && (
        <div className="history-task-body">
          {loading && <div className="thin-status"><Loader2 size={14} className="spinner" /> Loading activity…</div>}
          {error && <div className="error">{error}</div>}
          {history && <TaskActivityTimeline history={history} />}
        </div>
      )}
    </div>
  );
}

// Interleave audit events and emails into a single chronological timeline.
function TaskActivityTimeline({ history }: { history: TaskHistoryResponse }) {
  type TimelineItem =
    | { kind: "email"; at: string; data: TaskHistoryEmail }
    | { kind: "audit"; at: string; data: TaskHistoryAuditLog };

  const items: TimelineItem[] = [
    ...history.emails.map((e) => ({ kind: "email" as const, at: e.created_at, data: e })),
    ...history.audit_logs.map((a) => ({ kind: "audit" as const, at: a.created_at, data: a }))
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (items.length === 0) {
    return <p className="muted small">No activity recorded yet for this task.</p>;
  }

  return (
    <ul className="activity-timeline">
      {items.map((item, idx) =>
        item.kind === "email" ? (
          <ActivityEmail key={`e-${item.data.id}-${idx}`} email={item.data} />
        ) : (
          <ActivityAudit key={`a-${item.data.id}-${idx}`} log={item.data} />
        )
      )}
    </ul>
  );
}

function ActivityEmail({ email }: { email: TaskHistoryEmail }) {
  const [open, setOpen] = useState(false);
  const isOutbound = email.direction === "outbound";
  return (
    <li className={`activity-item activity-email ${isOutbound ? "outbound" : "inbound"}`}>
      <div className="activity-icon">
        {isOutbound ? <Send size={14} /> : <Mail size={14} />}
      </div>
      <div className="activity-body">
        <div className="activity-line">
          <strong>
            {isOutbound ? `Sent to ${email.to_email}` : `Reply from ${email.from_email}`}
          </strong>
          <span className="muted small">{new Date(email.created_at).toLocaleString()}</span>
        </div>
        <div className="activity-subject small">{email.subject}</div>
        <button className="ghost small inline-edit" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Hide message" : "Show message"}
        </button>
        {open && <pre className="activity-email-body">{email.body_text}</pre>}
      </div>
    </li>
  );
}

function ActivityAudit({ log }: { log: TaskHistoryAuditLog }) {
  const icon = iconForAuditEvent(log.event_type);
  return (
    <li className="activity-item activity-audit">
      <div className="activity-icon">{icon}</div>
      <div className="activity-body">
        <div className="activity-line">
          <strong>{humanizeEventType(log.event_type)}</strong>
          <span className="muted small">{new Date(log.created_at).toLocaleString()}</span>
        </div>
        <div className="small">{log.summary}</div>
      </div>
    </li>
  );
}

function iconForAuditEvent(eventType: string) {
  switch (eventType) {
    case "task_dispatched":
      return <Send size={14} />;
    case "task_approved":
      return <CheckCircle2 size={14} />;
    case "task_cancelled":
      return <X size={14} />;
    case "provider_contact_learned":
    case "provider_email_learned":
      return <Sparkles size={14} />;
    case "recall_checked":
      return <AlertTriangle size={14} />;
    case "insight_acted":
      return <ChevronRight size={14} />;
    case "document_uploaded":
    case "document_applied":
      return <FileImage size={14} />;
    default:
      return <Info size={14} />;
  }
}

function humanizeEventType(eventType: string): string {
  return eventType
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

// ============================================================
// PUSH NOTIFICATIONS PANEL (Settings tab)
// ============================================================
//
// Shown inside Settings. Lets the user opt in to web push so the agent can
// notify them ambiently when a dealer/carrier replies, without requiring
// the app to be open.
//
// Browser API path:
//   1. Service worker registers (in main.tsx) and exposes pushManager
//   2. Notification.requestPermission() — requires a user gesture to fire
//   3. pushManager.subscribe({ applicationServerKey }) — returns a sub object
//   4. POST that sub object to /api/push/subscribe
//
// Push doesn't work in private/incognito (browser silently blocks the
// service worker registration). We surface that as "not supported" rather
// than letting the toggle silently no-op.

function urlBase64ToUint8Array(base64: string): Uint8Array {
  // Web Push expects the applicationServerKey as a Uint8Array. VAPID public
  // keys come in URL-safe base64; convert to standard base64 then decode.
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const standard = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(standard);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function PushNotificationPanel() {
  const [supported] = useState(
    () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window
  );
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(
    () => (typeof Notification !== "undefined" ? Notification.permission : null)
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // On mount, check if this browser already has an active subscription.
  useEffect(() => {
    if (!supported) return;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        setSubscribed(Boolean(sub));
      } catch {
        setSubscribed(false);
      }
    })();
  }, [supported]);

  async function enable() {
    setBusy(true);
    setMessage(null);
    try {
      // 1. Get VAPID public key from server (so we don't have to bake it into the bundle).
      const { public_key, configured } = await api<{ public_key: string | null; configured: boolean }>(
        "/api/push/vapid-key"
      );
      if (!configured || !public_key) {
        setMessage("Push is not configured on the server yet.");
        return;
      }

      // 2. Ensure permission. requestPermission must be triggered by a user gesture
      //    (this onClick handler counts).
      let perm = Notification.permission;
      if (perm === "default") {
        perm = await Notification.requestPermission();
      }
      setPermission(perm);
      if (perm !== "granted") {
        setMessage(
          perm === "denied"
            ? "Notifications are blocked for this site. Enable them in your browser settings to turn this on."
            : "Permission was not granted."
        );
        return;
      }

      // 3. Subscribe via the service worker's push manager.
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          // Cast: TS strict-mode narrows Uint8Array's buffer to ArrayBufferLike
          // (could be SharedArrayBuffer), which doesn't satisfy BufferSource.
          // The runtime value is a plain Uint8Array, which the API accepts.
          applicationServerKey: urlBase64ToUint8Array(public_key) as BufferSource
        });
      }

      // 4. Send the subscription to the backend so it can push to this device later.
      const subJson = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
      if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) {
        throw new Error("Browser returned an incomplete subscription");
      }
      await api("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: subJson.endpoint,
          keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth }
        })
      });
      setSubscribed(true);
      setMessage("Notifications enabled on this device.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not enable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/api/push/subscribe", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: sub.endpoint })
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
      setMessage("Notifications disabled on this device.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not disable notifications.");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<{ delivered: number }>("/api/push/test", { method: "POST" });
      setMessage(
        result.delivered > 0
          ? `Test sent. Delivered to ${result.delivered} device${result.delivered === 1 ? "" : "s"}.`
          : "Test sent but no devices received it. Make sure notifications are enabled in this browser."
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Test push failed.");
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <>
        <h2 style={{ marginTop: 20 }}>Notifications</h2>
        <p className="small muted">
          This browser doesn't support push notifications. Try Chrome, Edge, or Firefox —
          or open Automoteev in a regular (non-private) window.
        </p>
      </>
    );
  }

  return (
    <>
      <h2 style={{ marginTop: 20 }}>Notifications</h2>
      <p className="small muted">
        Get an instant ping the moment a dealer or carrier replies — even when the app
        isn't open. Works on this device's browser.
      </p>
      <div className="button-row">
        {subscribed ? (
          <>
            <button className="secondary" type="button" onClick={disable} disabled={busy}>
              <BellOff size={16} /> {busy ? "Working…" : "Turn off on this device"}
            </button>
            <button className="ghost" type="button" onClick={sendTest} disabled={busy}>
              {busy ? <Loader2 size={14} className="spinner" /> : "Send test push"}
            </button>
          </>
        ) : (
          <button className="primary" type="button" onClick={enable} disabled={busy}>
            <Bell size={16} /> {busy ? "Enabling…" : "Enable notifications"}
          </button>
        )}
      </div>
      {permission === "denied" && (
        <p className="small muted" style={{ marginTop: 8 }}>
          Notifications are blocked for this site in your browser. Click the lock
          icon in the address bar to allow them.
        </p>
      )}
      {message && <div className="notice" style={{ marginTop: 8 }}>{message}</div>}
    </>
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

        <PushNotificationPanel />

        <h2 style={{ marginTop: 20 }}>Account</h2>
        <p className="small muted">
          Sign out of Automoteev on this device. Your data stays in your account and you can sign back in any time.
        </p>
        <button className="danger" type="button" onClick={() => supabase.auth.signOut()}>
          <LogOut size={16} /> Sign out
        </button>
      </div>

      <div className="panel coming-next">
        <h2>Coming next</h2>
        <p className="small muted">
          Automoteev's mission is to handle your recurring expenses, end to end. Your vehicle
          is the first one we tackle. Here's what's next on the roadmap.
        </p>
        <ul className="coming-next-list">
          <li>
            <ShieldCheck size={16} />
            <div>
              <strong>Home, life, and renters insurance</strong>
              <span className="small muted">Same shop-and-save loop, applied to every policy you carry.</span>
            </div>
          </li>
          <li>
            <DollarSign size={16} />
            <div>
              <strong>Subscription audits</strong>
              <span className="small muted">Catches the streaming, software, and gym charges you forgot you signed up for.</span>
            </div>
          </li>
          <li>
            <TrendingUp size={16} />
            <div>
              <strong>Recurring bill optimization</strong>
              <span className="small muted">Internet, mobile, energy — negotiate or switch when better deals appear.</span>
            </div>
          </li>
        </ul>
        <p className="small muted coming-next-vote">
          Want to vote on what we ship first? Reply to any Automoteev email with the category you want.
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

// Format a Haversine distance for display. Sub-mile shows as "<1 mi", whole
// numbers above 10 round to integer ("24 mi"), everything else gets one decimal.
function formatDistance(miles: number): string {
  if (miles < 1) return "<1 mi";
  if (miles >= 10) return `${Math.round(miles)} mi`;
  return `${miles.toFixed(1)} mi`;
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
