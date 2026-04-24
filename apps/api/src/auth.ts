import type { NextFunction, Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin, userScopedSupabase } from "./supabase.js";
import type { AuthUser } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      db?: SupabaseClient;
      accessToken?: string;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email };
  req.accessToken = token;
  req.db = userScopedSupabase(token);
  next();
}
