/**
 * One-time Google Ads OAuth bootstrap (and health check) for the agent PC.
 *
 *   npx tsx scripts/googleads-auth.ts            → run the OAuth consent flow, save the refresh token
 *   npx tsx scripts/googleads-auth.ts --verify   → refresh a token + list accessible customer ids
 *
 * Prerequisites (Andy does these once in a browser — see docs/CONTRACTS.md §10):
 *   1. A Google Cloud project with the Google Ads API enabled.
 *   2. An OAuth client of type "Desktop app" → clientId + clientSecret.
 *   3. A developer token from the Google Ads manager account (API Center).
 *   4. googleads.local.json in the repo root holding at least:
 *        { "clientId": "…", "clientSecret": "…", "developerToken": "…" }
 *
 * This script adds "refreshToken" to that file via the loopback flow: it starts a local
 * http listener, opens the consent URL, and captures the redirect. No secrets leave the PC.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { credsPath, verifyCredentials } from "../src/executors/googleAds";

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

function readLocal(): any {
  const p = credsPath();
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p}.\nCreate it first with your OAuth client + developer token:\n` +
      `  { "clientId": "…apps.googleusercontent.com", "clientSecret": "…", "developerToken": "…", "loginCustomerId": "manager id if any" }`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function openBrowser(url: string): void {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  execFile(cmd[0] as string, cmd[1] as string[], () => { /* fall back to the printed URL */ });
}

async function main(): Promise<void> {
  if (process.argv.includes("--verify")) {
    const r = await verifyCredentials();
    if (r.ok) {
      console.log(`Credentials OK. Accessible customer ids: ${r.customerIds?.join(", ") || "(none visible)"}`);
      console.log("Put the right one on the brand profile: marketer_brand_set { googleAds: { customerId, maxDailyBudget } }");
    } else {
      console.error(`Credentials check FAILED: ${r.error}`);
      process.exitCode = 1;
    }
    return;
  }

  const local = readLocal();
  if (!local.clientId || !local.clientSecret) {
    console.error("googleads.local.json needs clientId and clientSecret before the consent flow can run.");
    process.exit(1);
  }

  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: local.clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // force a refresh token even if previously consented
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", REDIRECT);
      if (u.pathname !== "/oauth2callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const got = u.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(err ? `<h3>OAuth failed: ${err}</h3>` : "<h3>Done — you can close this tab and return to the terminal.</h3>");
      server.close();
      err || !got ? reject(new Error(err || "no code in redirect")) : resolve(got);
    });
    server.listen(PORT, "127.0.0.1", () => {
      console.log("Opening Google consent screen (sign in as the Google Ads account owner)…\n" + authUrl + "\n");
      openBrowser(authUrl);
    });
    server.on("error", reject);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: local.clientId, client_secret: local.clientSecret,
      code, grant_type: "authorization_code", redirect_uri: REDIRECT,
    }),
  });
  const body: any = await res.json();
  if (!res.ok || !body.refresh_token) {
    console.error(`Token exchange failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }

  local.refreshToken = body.refresh_token;
  fs.writeFileSync(credsPath(), JSON.stringify(local, null, 2) + "\n");
  console.log(`Refresh token saved to ${path.basename(credsPath())}.`);

  if (!local.developerToken) {
    console.log("NOTE: developerToken is still missing — add it before the executor can run.");
    return;
  }
  const check = await verifyCredentials();
  console.log(check.ok
    ? `Verified. Accessible customer ids: ${check.customerIds?.join(", ") || "(none visible)"}`
    : `Saved, but verification failed: ${check.error}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
