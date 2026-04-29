import { env } from "../config.js";

const PLAID_HOSTS = {
  sandbox: "https://sandbox.plaid.com",
  development: "https://development.plaid.com",
  production: "https://production.plaid.com"
} as const;

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
  };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  name: string;
  merchant_name: string | null;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  category: string[] | null;
  payment_channel: string;
  pending: boolean;
}

interface PlaidErrorBody {
  error_message?: string;
  error_code?: string;
}

function plaidConfigured() {
  return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
}

export function getPlaidConfigStatus() {
  return {
    configured: plaidConfigured(),
    env: env.PLAID_ENV,
    products: plaidProducts(),
    country_codes: plaidCountryCodes()
  };
}

function plaidProducts() {
  return env.PLAID_PRODUCTS.split(",").map((p) => p.trim()).filter(Boolean);
}

function plaidCountryCodes() {
  return env.PLAID_COUNTRY_CODES.split(",").map((c) => c.trim()).filter(Boolean);
}

async function plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!plaidConfigured()) throw new Error("Plaid is not configured yet.");
  const response = await fetch(`${PLAID_HOSTS[env.PLAID_ENV]}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      ...body
    })
  });
  const json = (await response.json().catch(() => ({}))) as T & PlaidErrorBody;
  if (!response.ok) {
    throw new Error(json.error_message ?? json.error_code ?? `Plaid request failed: ${path}`);
  }
  return json as T;
}

export async function createPlaidLinkToken(params: {
  userId: string;
  userEmail?: string | null;
}) {
  return plaidPost<{ link_token: string; expiration: string }>("/link/token/create", {
    user: {
      client_user_id: params.userId,
      email_address: params.userEmail ?? undefined
    },
    client_name: "Automoteev",
    products: plaidProducts(),
    country_codes: plaidCountryCodes(),
    language: "en",
    webhook: env.PLAID_WEBHOOK_URL,
    redirect_uri: env.PLAID_REDIRECT_URI,
    transactions: {
      days_requested: 730
    }
  });
}

export async function exchangePlaidPublicToken(publicToken: string) {
  return plaidPost<{
    access_token: string;
    item_id: string;
    request_id: string;
  }>("/item/public_token/exchange", {
    public_token: publicToken
  });
}

export async function getPlaidItem(accessToken: string) {
  return plaidPost<{
    item: {
      item_id: string;
      institution_id: string | null;
      products: string[];
    };
  }>("/item/get", {
    access_token: accessToken
  });
}

export async function getPlaidInstitution(institutionId: string | null) {
  if (!institutionId) return null;
  return plaidPost<{
    institution: { institution_id: string; name: string };
  }>("/institutions/get_by_id", {
    institution_id: institutionId,
    country_codes: plaidCountryCodes()
  });
}

export async function getPlaidAccounts(accessToken: string) {
  return plaidPost<{ accounts: PlaidAccount[] }>("/accounts/get", {
    access_token: accessToken
  });
}

export async function syncPlaidTransactions(params: {
  accessToken: string;
  cursor: string | null;
}) {
  const added: PlaidTransaction[] = [];
  const modified: PlaidTransaction[] = [];
  const removed: { transaction_id: string }[] = [];
  let cursor = params.cursor ?? undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await plaidPost<{
      added: PlaidTransaction[];
      modified: PlaidTransaction[];
      removed: { transaction_id: string }[];
      next_cursor: string;
      has_more: boolean;
    }>("/transactions/sync", {
      access_token: params.accessToken,
      cursor,
      count: 500
    });
    added.push(...page.added);
    modified.push(...page.modified);
    removed.push(...page.removed);
    cursor = page.next_cursor;
    hasMore = page.has_more;
  }

  return {
    added,
    modified,
    removed,
    next_cursor: cursor ?? null
  };
}
