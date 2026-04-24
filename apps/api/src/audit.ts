import { supabaseAdmin } from "./supabase.js";

interface AuditParams {
  userId: string;
  taskId?: string | null;
  vehicleId?: string | null;
  eventType: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function audit(params: AuditParams) {
  await supabaseAdmin.from("task_audit_logs").insert({
    user_id: params.userId,
    task_id: params.taskId ?? null,
    vehicle_id: params.vehicleId ?? null,
    event_type: params.eventType,
    summary: params.summary,
    metadata: params.metadata ?? {}
  });
}
