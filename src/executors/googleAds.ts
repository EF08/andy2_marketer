/**
 * Google Ads — the first paid surface, and the first executor that acts through an API
 * instead of the browser (ADR 004). Two action types, mirroring the read/act split the
 * whole system is built on:
 *
 *   ads_report (read, auto)     — GAQL reports: campaigns, keywords, ads, search terms,
 *                                 account info, accessible customers, or a raw query.
 *   ads_mutate (act, approved)  — money-touching mutations: create_search_campaign,
 *                                 update_budget, set_status. Refuses to run without the
 *                                 server-side approval stamp, like every act type.
 *
 * The identity guard has an API analog: the backend stamps the brand's declared
 * customerId onto the claimed action (action.googleAds, the expectedHandle pattern), and
 * this executor refuses to touch any other account. The money rail is enforced three
 * times — linter at draft, backend stamp at claim, and again here (maxDailyBudget) —
 * because a budget typo is the ads equivalent of posting from the wrong account.
 *
 * Credentials live in googleads.local.json (gitignored) on the agent PC only; the
 * backend never holds them. Bootstrap with: npx tsx scripts/googleads-auth.ts
 */
import fs from "node:fs";
import path from "node:path";
import { MarketerConfig } from "../config/types";
import type { Action, ActionResult } from "./index";
import { ActionError, FailureCode, toFailure } from "./xCommon";

/* ────────────────────────────── credentials ────────────────────────────── */

export type GoogleAdsCreds = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  developerToken: string;
  /** Manager (MCC) account id, digits only — required when the OAuth user reaches the account through a manager. */
  loginCustomerId?: string;
  /** API version, e.g. "v25". A sunset is a config edit, not a code change. */
  apiVersion?: string;
  /** Optional allowlist. When present, any action naming another account is refused — protects real money from a bad upstream stamp. */
  allowedCustomerIds?: string[];
};

const CREDS_FILE = "googleads.local.json";
const DEFAULT_API_VERSION = "v25";

export function credsPath(): string {
  return path.resolve(process.cwd(), CREDS_FILE);
}

/** null when the file is missing/incomplete — the executor turns that into login_required. */
export function resolveGoogleAdsCreds(): GoogleAdsCreds | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credsPath(), "utf-8"));
    const creds: GoogleAdsCreds = {
      clientId: String(raw.clientId ?? ""),
      clientSecret: String(raw.clientSecret ?? ""),
      refreshToken: String(raw.refreshToken ?? ""),
      developerToken: String(raw.developerToken ?? ""),
      loginCustomerId: raw.loginCustomerId ? onlyDigits(raw.loginCustomerId) : undefined,
      apiVersion: raw.apiVersion ? String(raw.apiVersion) : undefined,
      allowedCustomerIds: Array.isArray(raw.allowedCustomerIds) ? raw.allowedCustomerIds.map(onlyDigits) : undefined,
    };
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken || !creds.developerToken) return null;
    return creds;
  } catch {
    return null;
  }
}

function onlyDigits(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

/* ────────────────────────────── OAuth token ────────────────────────────── */

let tokenCache: { accessToken: string; expiresAt: number } | null = null;

async function accessToken(creds: GoogleAdsCreds): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.accessToken;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    tokenCache = null;
    throw new ActionError(
      "login_required",
      `OAuth refresh failed (HTTP ${res.status}${body.error ? `, ${body.error}` : ""}) — re-run scripts/googleads-auth.ts on the agent PC.`,
    );
  }
  tokenCache = { accessToken: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return tokenCache.accessToken;
}

/* ────────────────────────────── REST client ────────────────────────────── */

function apiBase(creds: GoogleAdsCreds): string {
  return `https://googleads.googleapis.com/${creds.apiVersion || DEFAULT_API_VERSION}`;
}

/** One Google Ads REST call, with the failure taxonomy mapped from the HTTP status. */
async function gadsFetch(creds: GoogleAdsCreds, method: "GET" | "POST", pathname: string, body?: unknown): Promise<any> {
  const token = await accessToken(creds);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "developer-token": creds.developerToken,
    "content-type": "application/json",
  };
  if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId;

  const res = await fetch(`${apiBase(creds)}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.ok) return res.json();

  const errBody: any = await res.json().catch(() => ({}));
  // The API nests the useful message deep; surface the most specific one it offers.
  const detail =
    errBody?.error?.details?.[0]?.errors?.[0]?.message ||
    errBody?.[0]?.error?.details?.[0]?.errors?.[0]?.message ||
    errBody?.error?.message ||
    `HTTP ${res.status}`;
  const code: FailureCode =
    res.status === 401 ? "login_required"
    : res.status === 403 ? "blocked"
    : res.status === 404 ? "not_found"
    : res.status === 429 ? "rate_limited"
    : res.status === 400 ? "bad_params"
    : "platform_error";
  throw new ActionError(code, `Google Ads API: ${detail}`);
}

async function gaql(creds: GoogleAdsCreds, customerId: string, query: string): Promise<any[]> {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const body: any = { query };
    if (pageToken) body.pageToken = pageToken;
    const page = await gadsFetch(creds, "POST", `/customers/${customerId}/googleAds:search`, body);
    out.push(...(page.results || []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 10_000);
  return out;
}

async function mutate(creds: GoogleAdsCreds, customerId: string, mutateOperations: any[], { validateOnly = false } = {}): Promise<any> {
  return gadsFetch(creds, "POST", `/customers/${customerId}/googleAds:mutate`, {
    mutateOperations,
    partialFailure: false, // all-or-nothing: half a campaign is worse than no campaign
    validateOnly,
  });
}

/* ────────────────────────────── shared guards ────────────────────────────── */

function requireCreds(): GoogleAdsCreds {
  const creds = resolveGoogleAdsCreds();
  if (!creds) {
    throw new ActionError(
      "login_required",
      `no Google Ads credentials on this PC — create ${CREDS_FILE} via scripts/googleads-auth.ts (clientId, clientSecret, developerToken, refreshToken).`,
    );
  }
  return creds;
}

/**
 * The account this action may touch. Comes from the backend's claim-time stamp of the
 * brand profile (never from params — Claude cannot point an action at an arbitrary
 * account), then through the local allowlist if one is configured.
 */
function requireCustomerId(action: Action, creds: GoogleAdsCreds): string {
  const stamped = onlyDigits(action.googleAds?.customerId);
  if (!stamped) {
    throw new ActionError(
      "bad_params",
      `brand '${action.brandId ?? "?"}' declares no googleAds.customerId — set it with marketer_brand_set before drafting ads actions.`,
    );
  }
  if (creds.allowedCustomerIds?.length && !creds.allowedCustomerIds.includes(stamped)) {
    throw new ActionError(
      "bad_params",
      `wrong_identity: customer ${stamped} is not in this PC's allowedCustomerIds — refusing to touch an account the agent does not own.`,
    );
  }
  return stamped;
}

const micros = (units: number) => Math.round(units * 1_000_000);
const fromMicros = (m: unknown) => (m === undefined || m === null ? null : Number(m) / 1_000_000);

/* ────────────────────────────── ads_report ────────────────────────────── */

const REPORTS: Record<string, (days: number) => string> = {
  campaigns: (days) => `
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           campaign_budget.amount_micros,
           metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc,
           metrics.cost_micros, metrics.conversions
    FROM campaign WHERE segments.date DURING ${last(days)} ORDER BY metrics.cost_micros DESC`,
  keywords: (days) => `
    SELECT campaign.name, ad_group.name, ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type, ad_group_criterion.status,
           metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions
    FROM keyword_view WHERE segments.date DURING ${last(days)} ORDER BY metrics.clicks DESC`,
  ads: (days) => `
    SELECT campaign.name, ad_group.name, ad_group_ad.ad.id, ad_group_ad.status,
           ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.final_urls,
           metrics.impressions, metrics.clicks, metrics.ctr, metrics.cost_micros, metrics.conversions
    FROM ad_group_ad WHERE segments.date DURING ${last(days)} ORDER BY metrics.clicks DESC`,
  search_terms: (days) => `
    SELECT campaign.name, search_term_view.search_term, search_term_view.status,
           metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM search_term_view WHERE segments.date DURING ${last(days)} ORDER BY metrics.clicks DESC`,
  account: () => `
    SELECT customer.id, customer.descriptive_name, customer.currency_code,
           customer.time_zone, customer.status FROM customer`,
};

/** GAQL only accepts fixed DURING windows; snap to the nearest one at or above `days`. */
function last(days: number): string {
  if (days <= 7) return "LAST_7_DAYS";
  if (days <= 14) return "LAST_14_DAYS";
  return "LAST_30_DAYS";
}

export async function runAdsReport(action: Action, _config: MarketerConfig): Promise<ActionResult> {
  try {
    if (action.platform !== "google") {
      throw new ActionError("bad_params", `ads_report runs on platform 'google', not '${action.platform ?? "none"}'.`);
    }
    const creds = requireCreds();
    const p = action.params || {};

    // The one report that exists before any account is wired up — used to find customer ids.
    if (p.what === "accessible_customers") {
      const r = await gadsFetch(creds, "GET", "/customers:listAccessibleCustomers");
      const resourceNames: string[] = r.resourceNames || [];
      return { ok: true, result: { what: "accessible_customers", customerIds: resourceNames.map((n) => n.split("/")[1]) } };
    }

    const customerId = requireCustomerId(action, creds);
    const days = Math.min(Math.max(Number(p.days) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(p.limit) || 200, 1), 1000);

    let query: string;
    if (typeof p.query === "string" && p.query.trim()) {
      if (!/^\s*SELECT\s/i.test(p.query)) throw new ActionError("bad_params", "params.query must be a GAQL SELECT statement.");
      query = p.query;
    } else {
      const canned = REPORTS[String(p.what || "campaigns")];
      if (!canned) throw new ActionError("bad_params", `unknown report '${p.what}'. Valid: ${[...Object.keys(REPORTS), "accessible_customers"].join(", ")}, or raw params.query GAQL.`);
      query = canned(days);
    }

    const rows = await gaql(creds, customerId, query);
    // Cost fields stay micros in the raw rows; the rollup below is the human-readable read.
    const totals = rows.reduce(
      (t, r) => ({
        impressions: t.impressions + Number(r.metrics?.impressions || 0),
        clicks: t.clicks + Number(r.metrics?.clicks || 0),
        cost: t.cost + Number(r.metrics?.costMicros || 0) / 1_000_000,
        conversions: t.conversions + Number(r.metrics?.conversions || 0),
      }),
      { impressions: 0, clicks: 0, cost: 0, conversions: 0 },
    );
    return {
      ok: true,
      result: {
        platform: "google", what: p.query ? "query" : String(p.what || "campaigns"),
        customerId, days: p.query || p.what === "account" ? undefined : days,
        rowCount: rows.length, truncated: rows.length > limit,
        rows: rows.slice(0, limit),
        totals: rows.some((r) => r.metrics) ? totals : undefined,
      },
    };
  } catch (e) {
    return toFailure(e);
  }
}

/* ────────────────────────────── ads_mutate ────────────────────────────── */

export async function runAdsMutate(action: Action, _config: MarketerConfig): Promise<ActionResult> {
  try {
    if (action.platform !== "google") {
      throw new ActionError("bad_params", `ads_mutate runs on platform 'google', not '${action.platform ?? "none"}'.`);
    }
    // Belt and braces: index.ts already refuses unapproved act types, but money gets its own check.
    if (!action.approvedAt) throw new ActionError("bad_params", "refused: ads_mutate arrived without a server-side approval stamp.");

    const creds = requireCreds();
    const customerId = requireCustomerId(action, creds);
    const p = action.params || {};
    const dryRun = p.dryRun === true;

    switch (String(p.op || "")) {
      case "create_search_campaign":
        return await createSearchCampaign(creds, customerId, action, dryRun);
      case "update_budget":
        return await updateBudget(creds, customerId, action, dryRun);
      case "set_status":
        return await setStatus(creds, customerId, action, dryRun);
      default:
        throw new ActionError("bad_params", `unknown op '${p.op}'. Valid: create_search_campaign, update_budget, set_status.`);
    }
  } catch (e) {
    return toFailure(e);
  }
}

/**
 * The last line of the money rail: the backend stamped the brand's cap onto the action at
 * claim time, and no budget leaves this function above it. A missing cap refuses — money
 * is default-closed, exactly like identity.
 */
function requireBudgetWithinCap(action: Action, dailyBudget: unknown): number {
  const budget = Number(dailyBudget);
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new ActionError("bad_params", "dailyBudget must be a positive number (in the ad account's currency).");
  }
  const cap = Number(action.googleAds?.maxDailyBudget);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new ActionError("bad_params", `brand '${action.brandId ?? "?"}' declares no googleAds.maxDailyBudget — set the cap before spending money.`);
  }
  if (budget > cap) {
    throw new ActionError("bad_params", `dailyBudget ${budget} exceeds the brand's maxDailyBudget cap of ${cap}.`);
  }
  return budget;
}

const asText = (v: unknown) => String(v ?? "").trim();

async function createSearchCampaign(creds: GoogleAdsCreds, customerId: string, action: Action, dryRun: boolean): Promise<ActionResult> {
  const p = action.params || {};
  const name = asText(p.name);
  const finalUrl = asText(p.finalUrl);
  const headlines: string[] = (Array.isArray(p.headlines) ? p.headlines : []).map(asText).filter(Boolean);
  const descriptions: string[] = (Array.isArray(p.descriptions) ? p.descriptions : []).map(asText).filter(Boolean);
  if (!name) throw new ActionError("bad_params", "params.name is required.");
  if (!/^https:\/\//i.test(finalUrl)) throw new ActionError("bad_params", "params.finalUrl must be an https URL.");
  if (headlines.length < 3 || headlines.length > 15) throw new ActionError("bad_params", `a responsive search ad needs 3-15 headlines (got ${headlines.length}).`);
  if (descriptions.length < 2 || descriptions.length > 4) throw new ActionError("bad_params", `a responsive search ad needs 2-4 descriptions (got ${descriptions.length}).`);
  const overH = headlines.filter((h) => h.length > 30);
  const overD = descriptions.filter((d) => d.length > 90);
  if (overH.length) throw new ActionError("bad_params", `headline over 30 chars: "${overH[0]}" (${overH[0].length}).`);
  if (overD.length) throw new ActionError("bad_params", `description over 90 chars: "${overD[0]}" (${overD[0].length}).`);
  const dailyBudget = requireBudgetWithinCap(action, p.dailyBudget);

  const keywords: { text: string; matchType: string }[] = (Array.isArray(p.keywords) ? p.keywords : []).map((k: any) => ({
    text: asText(typeof k === "string" ? k : k?.text),
    matchType: ["BROAD", "PHRASE", "EXACT"].includes(String(k?.matchType || "").toUpperCase()) ? String(k.matchType).toUpperCase() : "PHRASE",
  })).filter((k) => k.text);

  const budgetRes = `customers/${customerId}/campaignBudgets/-1`;
  const campaignRes = `customers/${customerId}/campaigns/-2`;
  const adGroupRes = `customers/${customerId}/adGroups/-3`;

  const ops: any[] = [
    { campaignBudgetOperation: { create: { resourceName: budgetRes, name: `${name} budget`, amountMicros: String(micros(dailyBudget)), deliveryMethod: "STANDARD", explicitlyShared: false } } },
    {
      campaignOperation: {
        create: {
          resourceName: campaignRes,
          name,
          // PAUSED unless explicitly told otherwise: approval said "this may exist",
          // activation is its own decision — the same posture as the Meta test setup.
          status: p.activate === true ? "ENABLED" : "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budgetRes,
          targetSpend: {}, // Maximize clicks — no per-keyword bids to get wrong on day one
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    ...(Array.isArray(p.locationIds) ? p.locationIds : []).map((id: any) => ({
      campaignCriterionOperation: { create: { campaign: campaignRes, location: { geoTargetConstant: `geoTargetConstants/${onlyDigits(id)}` } } },
    })),
    ...(Array.isArray(p.languageIds) ? p.languageIds : []).map((id: any) => ({
      campaignCriterionOperation: { create: { campaign: campaignRes, language: { languageConstant: `languageConstants/${onlyDigits(id)}` } } },
    })),
    { adGroupOperation: { create: { resourceName: adGroupRes, name: `${name} - ad group`, campaign: campaignRes, type: "SEARCH_STANDARD", status: "ENABLED" } } },
    ...keywords.map((k) => ({
      adGroupCriterionOperation: { create: { adGroup: adGroupRes, status: "ENABLED", keyword: { text: k.text, matchType: k.matchType } } },
    })),
    {
      adGroupAdOperation: {
        create: {
          adGroup: adGroupRes,
          status: "ENABLED",
          ad: {
            finalUrls: [finalUrl],
            responsiveSearchAd: {
              headlines: headlines.map((text) => ({ text })),
              descriptions: descriptions.map((text) => ({ text })),
              ...(asText(p.path1) ? { path1: asText(p.path1) } : {}),
              ...(asText(p.path2) ? { path2: asText(p.path2) } : {}),
            },
          },
        },
      },
    },
  ];

  if (dryRun) {
    await mutate(creds, customerId, ops, { validateOnly: true });
    return {
      ok: true,
      result: {
        platform: "google", op: "create_search_campaign", dryRun: true, customerId, verified: null,
        name, dailyBudget, status: p.activate === true ? "ENABLED" : "PAUSED",
        operations: ops.length, keywords: keywords.length,
        note: "validateOnly — Google accepted every operation; nothing was created.",
      },
    };
  }

  const r = await mutate(creds, customerId, ops);
  const responses: any[] = r.mutateOperationResponses || [];
  const created = {
    budget: responses[0]?.campaignBudgetResult?.resourceName || null,
    campaign: responses.find((x) => x.campaignResult)?.campaignResult?.resourceName || null,
    adGroup: responses.find((x) => x.adGroupResult)?.adGroupResult?.resourceName || null,
    ad: responses.find((x) => x.adGroupAdResult)?.adGroupAdResult?.resourceName || null,
    keywords: responses.filter((x) => x.adGroupCriterionResult).map((x) => x.adGroupCriterionResult.resourceName),
  };

  // Verify-after-act: read the campaign back. The mutate succeeding is Google's word;
  // the row existing with the right status and budget is evidence.
  const check = created.campaign
    ? await gaql(creds, customerId, `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros FROM campaign WHERE campaign.resource_name = '${created.campaign}'`)
    : [];
  const row = check[0] || null;
  const verified = !!row && row.campaign?.name === name;

  return {
    ok: true,
    result: {
      platform: "google", op: "create_search_campaign", customerId, verified,
      failureCode: verified ? undefined : "ambiguous",
      campaignId: row?.campaign?.id || null, name,
      status: row?.campaign?.status || null,
      dailyBudget: fromMicros(row?.campaignBudget?.amountMicros) ?? dailyBudget,
      created,
      note: verified
        ? `campaign created ${p.activate === true ? "ENABLED — it is spending" : "PAUSED — activate it in Google Ads (or via set_status) when ready"}.`
        : "mutate returned success but the verification read did not find the campaign — check the account before retrying.",
    },
    error: verified ? undefined : "ambiguous: created but not found on verification read",
  };
}

/** Look up one campaign (id → name/status/budget resource). */
async function findCampaign(creds: GoogleAdsCreds, customerId: string, campaignId: unknown): Promise<any> {
  const id = onlyDigits(campaignId);
  if (!id) throw new ActionError("bad_params", "params.campaignId is required (numeric).");
  const rows = await gaql(
    creds, customerId,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.resource_name, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.id = ${id}`,
  );
  if (!rows.length) throw new ActionError("not_found", `no campaign with id ${id} in customer ${customerId}.`);
  return rows[0];
}

async function updateBudget(creds: GoogleAdsCreds, customerId: string, action: Action, dryRun: boolean): Promise<ActionResult> {
  const p = action.params || {};
  const dailyBudget = requireBudgetWithinCap(action, p.dailyBudget);
  const row = await findCampaign(creds, customerId, p.campaignId);
  const budgetRes = row.campaignBudget?.resourceName;
  if (!budgetRes) throw new ActionError("platform_error", "campaign has no budget resource — unexpected.");
  const before = fromMicros(row.campaignBudget?.amountMicros);

  const ops = [{ campaignBudgetOperation: { update: { resourceName: budgetRes, amountMicros: String(micros(dailyBudget)) }, updateMask: "amount_micros" } }];
  if (dryRun) {
    await mutate(creds, customerId, ops, { validateOnly: true });
    return { ok: true, result: { platform: "google", op: "update_budget", dryRun: true, customerId, verified: null, campaignId: row.campaign.id, campaign: row.campaign.name, dailyBudgetBefore: before, dailyBudget, note: "validateOnly — nothing changed." } };
  }
  await mutate(creds, customerId, ops);

  const after = await findCampaign(creds, customerId, p.campaignId);
  const nowBudget = fromMicros(after.campaignBudget?.amountMicros);
  const verified = nowBudget !== null && Math.abs(nowBudget - dailyBudget) < 0.005;
  return {
    ok: true,
    result: {
      platform: "google", op: "update_budget", customerId, verified,
      failureCode: verified ? undefined : "ambiguous",
      campaignId: after.campaign?.id, campaign: after.campaign?.name,
      dailyBudgetBefore: before, dailyBudget: nowBudget,
    },
    error: verified ? undefined : "ambiguous: update accepted but the re-read budget does not match",
  };
}

async function setStatus(creds: GoogleAdsCreds, customerId: string, action: Action, dryRun: boolean): Promise<ActionResult> {
  const p = action.params || {};
  const status = String(p.status || "").toUpperCase();
  if (!["ENABLED", "PAUSED"].includes(status)) throw new ActionError("bad_params", "params.status must be ENABLED or PAUSED.");
  const row = await findCampaign(creds, customerId, p.campaignId);
  const before = row.campaign?.status;

  const ops = [{ campaignOperation: { update: { resourceName: row.campaign.resourceName, status }, updateMask: "status" } }];
  if (dryRun) {
    await mutate(creds, customerId, ops, { validateOnly: true });
    return { ok: true, result: { platform: "google", op: "set_status", dryRun: true, customerId, verified: null, campaignId: row.campaign.id, campaign: row.campaign.name, statusBefore: before, status, note: "validateOnly — nothing changed." } };
  }
  await mutate(creds, customerId, ops);

  const after = await findCampaign(creds, customerId, p.campaignId);
  const verified = after.campaign?.status === status;
  return {
    ok: true,
    result: {
      platform: "google", op: "set_status", customerId, verified,
      failureCode: verified ? undefined : "ambiguous",
      campaignId: after.campaign?.id, campaign: after.campaign?.name,
      statusBefore: before, status: after.campaign?.status,
      note: status === "ENABLED" && verified ? "campaign is ENABLED — it is spending." : undefined,
    },
    error: verified ? undefined : "ambiguous: update accepted but the re-read status does not match",
  };
}

/** Used by the auth bootstrap script's --verify mode. */
export async function verifyCredentials(): Promise<{ ok: boolean; customerIds?: string[]; error?: string }> {
  try {
    const creds = requireCreds();
    const r = await gadsFetch(creds, "GET", "/customers:listAccessibleCustomers");
    return { ok: true, customerIds: (r.resourceNames || []).map((n: string) => n.split("/")[1]) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
