/**
 * MCP server stub for Automoteev.
 *
 * Three tools are exposed:
 *   - get_vehicle_status(vehicle_id?)         → returns dashboard JSON
 *   - get_recommendations(vehicle_id?)        → returns insights with categories + estimated savings
 *   - create_task_from_recommendation(insight_key, vehicle_id?) → creates a needs_user_approval task,
 *       returns task ID and a deep link to approve in the web app
 *
 * Auth model:
 *   - User connects their AI host (Claude Desktop, ChatGPT, etc.) via OAuth.
 *   - For now, this stub uses a simple access token model: the user generates a
 *     personal access token in the web app and pastes it into the AI host.
 *     OAuth flow comes in the next sprint.
 *   - Tokens map 1:1 to a user, are stored hashed in mcp_connections, and grant
 *     the same permissions as the user's session.
 *
 * Free tier: read-only tools (get_*).
 * Pro tier: write tools (create_task_from_recommendation).
 */

import { Router, type Request, type Response } from "express";
import { createHash, randomBytes } from "crypto";
import { supabaseAdmin } from "../supabase.js";
import { generateInsights, statusFromInsights } from "../engines/insights.js";
import { isPro } from "../services/agent.js";

export const mcpRouter = Router();

// ---------- well-known discovery ----------
mcpRouter.get("/.well-known/mcp", (_req, res) => {
  res.json({
    name: "Automoteev",
    description:
      "AI agent for your vehicle's financial life. Tracks insurance, loan, recalls, service, and savings opportunities. Acts on your behalf when you approve.",
    version: "0.1.0",
    transport: "http",
    endpoint: "/mcp",
    auth: {
      type: "bearer",
      token_endpoint: "/mcp/auth/token"
    },
    tools: [
      {
        name: "get_vehicle_status",
        description: "Get current dashboard for a vehicle (or default vehicle if none specified).",
        free_tier: true
      },
      {
        name: "get_recommendations",
        description: "Get prioritized list of recommendations for a vehicle.",
        free_tier: true
      },
      {
        name: "create_task_from_recommendation",
        description:
          "Create a task in needs_user_approval state from a recommendation. Returns a deep link for the user to approve in the web app.",
        free_tier: false
      }
    ]
  });
});

// ---------- token issuance (called from web app, returns a token to copy/paste) ----------
mcpRouter.post("/mcp/auth/token", async (req: Request, res: Response) => {
  // This endpoint is mounted INSIDE the user-auth gate (see index.ts), so req.user is set.
  const userId = (req as any).user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const clientName = (req.body?.client_name as string) ?? "MCP Client";
  const rawToken = `aev_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");

  const { error } = await supabaseAdmin.from("mcp_connections").insert({
    user_id: userId,
    client_name: clientName,
    access_token_hash: tokenHash,
    scopes: ["read:vehicle", "read:recommendations", "write:tasks"]
  });
  if (error) return res.status(400).json({ error: error.message });

  // We return the raw token ONCE — caller stores it; we only keep the hash.
  res.json({ access_token: rawToken, token_type: "bearer" });
});

// ---------- main MCP HTTP transport ----------
// Implements a minimal subset of the MCP protocol over JSON-RPC over HTTP POST.
// AI hosts that support remote MCP servers can connect to /mcp directly.
mcpRouter.post("/mcp", async (req: Request, res: Response) => {
  const auth = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!auth) return res.status(401).json({ error: "unauthorized" });

  const tokenHash = createHash("sha256").update(auth).digest("hex");
  const { data: conn } = await supabaseAdmin
    .from("mcp_connections")
    .select("user_id, revoked_at")
    .eq("access_token_hash", tokenHash)
    .maybeSingle();

  if (!conn || conn.revoked_at) {
    return res.status(401).json({ error: "invalid_token" });
  }
  const userId = conn.user_id;

  // Update last_used_at (don't await — fire and forget)
  void supabaseAdmin
    .from("mcp_connections")
    .update({ last_used_at: new Date().toISOString() })
    .eq("access_token_hash", tokenHash);

  const { method, params, id } = req.body ?? {};

  try {
    switch (method) {
      case "initialize":
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "0.1",
            serverInfo: { name: "automoteev", version: "0.1.0" },
            capabilities: { tools: {} }
          }
        });

      case "tools/list":
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "get_vehicle_status",
                description:
                  "Get the current dashboard for the user's vehicle. Returns valuation, insurance, loan, recalls, maintenance, recommendations.",
                inputSchema: {
                  type: "object",
                  properties: {
                    vehicle_id: {
                      type: "string",
                      description: "Optional vehicle ID. Defaults to the user's most recently created vehicle."
                    }
                  }
                }
              },
              {
                name: "get_recommendations",
                description:
                  "Get prioritized recommendations (insights). Each has a key, severity, title, body, and CTA.",
                inputSchema: {
                  type: "object",
                  properties: {
                    vehicle_id: { type: "string" }
                  }
                }
              },
              {
                name: "create_task_from_recommendation",
                description:
                  "Create a needs_user_approval task from a recommendation key. The user approves in the web app; returns a deep link.",
                inputSchema: {
                  type: "object",
                  required: ["insight_key"],
                  properties: {
                    insight_key: { type: "string" },
                    vehicle_id: { type: "string" }
                  }
                }
              }
            ]
          }
        });

      case "tools/call": {
        const toolName = params?.name as string;
        const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
        const result = await callTool(userId, toolName, toolArgs);
        return res.json({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
          }
        });
      }

      default:
        return res.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
    }
  } catch (err) {
    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err instanceof Error ? err.message : "Internal error" }
    });
  }
});

async function callTool(userId: string, toolName: string, args: Record<string, unknown>) {
  switch (toolName) {
    case "get_vehicle_status": {
      const vehicleId = (args.vehicle_id as string) ?? (await defaultVehicleId(userId));
      if (!vehicleId) return { error: "no vehicle on file. user must complete onboarding in the web app first." };
      return await buildDashboardData(userId, vehicleId);
    }

    case "get_recommendations": {
      const vehicleId = (args.vehicle_id as string) ?? (await defaultVehicleId(userId));
      if (!vehicleId) return { error: "no vehicle on file" };
      const dashboard = await buildDashboardData(userId, vehicleId);
      if ("error" in dashboard) return dashboard;
      return { recommendations: dashboard.insights };
    }

    case "create_task_from_recommendation": {
      const pro = await isPro(userId);
      if (!pro) {
        return {
          error: "pro_required",
          message:
            "Creating tasks requires Automoteev Pro. The user can upgrade at https://automoteev.com/settings."
        };
      }
      const insightKey = args.insight_key as string;
      const vehicleId = (args.vehicle_id as string) ?? (await defaultVehicleId(userId));
      if (!vehicleId || !insightKey) return { error: "vehicle_id and insight_key required" };

      // Generate insights and find the matching one
      const dashboard = await buildDashboardData(userId, vehicleId);
      if ("error" in dashboard) return dashboard;
      const insight = dashboard.insights.find((i: any) => i.key === insightKey);
      if (!insight) return { error: "insight not found in current recommendations" };
      if (insight.action.type !== "create_task") {
        return { error: "this recommendation is not a task action" };
      }

      const { data: task } = await supabaseAdmin
        .from("vehicle_tasks")
        .insert({
          user_id: userId,
          vehicle_id: vehicleId,
          task_type: insight.action.task_type ?? "general",
          category: insight.category,
          title: insight.action.task_title ?? insight.title,
          description: insight.body,
          status: "needs_user_approval",
          approval_summary: insight.action.approval_summary ?? null,
          shared_fields: insight.action.shared_fields ?? null
        })
        .select()
        .single();

      return {
        task_id: task?.id,
        approval_url: `https://automoteev.com/tasks/${task?.id}`,
        message: `Task created. Tell the user to tap this link to approve: https://automoteev.com/tasks/${task?.id}`
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function defaultVehicleId(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("vehicles")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function buildDashboardData(userId: string, vehicleId: string) {
  // Same logic as the web dashboard endpoint — kept here so MCP can run independently.
  const { data: vehicle } = await supabaseAdmin
    .from("vehicles")
    .select("*")
    .eq("id", vehicleId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!vehicle) return { error: "vehicle not found" };

  const [costProfile, loanLease, insurance, maintItems, recalls, providers, fuel, activeTasks] = await Promise.all([
    supabaseAdmin.from("vehicle_cost_profiles").select("*").eq("vehicle_id", vehicleId).maybeSingle(),
    supabaseAdmin.from("loan_lease_accounts").select("*").eq("vehicle_id", vehicleId).maybeSingle(),
    supabaseAdmin.from("insurance_accounts").select("*").eq("vehicle_id", vehicleId).maybeSingle(),
    supabaseAdmin.from("maintenance_items").select("*").eq("vehicle_id", vehicleId),
    supabaseAdmin.from("recalls").select("*").eq("vehicle_id", vehicleId).is("resolved_at", null),
    supabaseAdmin.from("providers").select("id").eq("user_id", userId).eq("is_preferred", true).limit(1),
    supabaseAdmin
      .from("fuel_entries")
      .select("entry_date")
      .eq("vehicle_id", vehicleId)
      .order("entry_date", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("vehicle_tasks")
      .select("task_type")
      .eq("vehicle_id", vehicleId)
      .in("status", ["needs_user_approval", "approved", "in_progress", "waiting_on_provider"])
  ]);

  const lastShoppedAt = (insurance.data as any)?.last_shopped_at;
  const lastFuelEntry = (fuel.data ?? [])[0]?.entry_date;

  const insights = generateInsights({
    vehicle,
    costProfile: costProfile.data,
    loanLease: loanLease.data,
    insurance: insurance.data,
    maintenanceItems: maintItems.data ?? null,
    openRecallCount: (recalls.data ?? []).length,
    preferredServiceShopExists: (providers.data ?? []).length > 0,
    monthsSinceLastFuelEntry: lastFuelEntry
      ? Math.floor((Date.now() - new Date(lastFuelEntry).getTime()) / (30 * 86_400_000))
      : null,
    daysSinceLastInsuranceShop: lastShoppedAt
      ? Math.floor((Date.now() - new Date(lastShoppedAt).getTime()) / 86_400_000)
      : null,
    activeTaskTypes: new Set((activeTasks.data ?? []).map((t: any) => t.task_type))
  });

  return {
    vehicle: {
      id: vehicle.id,
      name: `${vehicle.year ?? ""} ${vehicle.make ?? ""} ${vehicle.model ?? ""}`.trim(),
      vin: vehicle.vin,
      mileage: vehicle.mileage,
      ownership_type: vehicle.ownership_type,
      overall_status: statusFromInsights(insights),
      recall_status: vehicle.recall_status
    },
    valuation: vehicle.market_value_low_cents
      ? {
          market_low_usd: vehicle.market_value_low_cents / 100,
          market_high_usd: vehicle.market_value_high_cents / 100,
          dealer_low_usd: vehicle.dealer_value_low_cents / 100,
          dealer_high_usd: vehicle.dealer_value_high_cents / 100
        }
      : null,
    insurance: insurance.data
      ? {
          carrier: (insurance.data as any).carrier_name,
          monthly_premium_usd: (insurance.data as any).premium_cents
            ? (insurance.data as any).premium_cents / 100
            : null,
          renewal_date: (insurance.data as any).renewal_date
        }
      : null,
    loan: loanLease.data
      ? {
          lender: (loanLease.data as any).lender_name,
          balance_usd: (loanLease.data as any).balance_cents
            ? (loanLease.data as any).balance_cents / 100
            : null,
          apr_pct: (loanLease.data as any).apr_bps ? (loanLease.data as any).apr_bps / 100 : null,
          monthly_payment_usd: (loanLease.data as any).monthly_payment_cents
            ? (loanLease.data as any).monthly_payment_cents / 100
            : null
        }
      : null,
    open_recall_count: (recalls.data ?? []).length,
    insights: insights.map((i) => ({
      key: i.key,
      category: i.category,
      severity: i.severity,
      title: i.title,
      body: i.body,
      cta_label: i.cta_label,
      action: i.action,
      action_type: i.action.type,
      estimated_savings_usd_per_year: i.estimated_savings_usd_per_year ?? null
    })),
    total_estimated_annual_savings_usd: insights.reduce(
      (sum, i) => sum + (i.estimated_savings_usd_per_year ?? 0),
      0
    )
  };
}
