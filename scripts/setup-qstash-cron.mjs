/**
 * Create a 1-minute Upstash QStash schedule → production keeper cron.
 *
 * Env:
 *   QSTASH_TOKEN  — Upstash console → QStash → token
 *   CRON_SECRET   — same as Vercel CRON_SECRET
 *   APP_URL       — https://your-app.vercel.app (no trailing slash)
 *
 * PowerShell:
 *   $env:QSTASH_TOKEN="..."
 *   $env:CRON_SECRET="..."
 *   $env:APP_URL="https://rite-mehidy-s-projects.vercel.app"
 *   node scripts/setup-qstash-cron.mjs
 */

const token = process.env.QSTASH_TOKEN?.trim();
const secret = process.env.CRON_SECRET?.trim();
const appUrl = (process.env.APP_URL || "").replace(/\/$/, "");

if (!token || !secret || !appUrl) {
  console.error("Set QSTASH_TOKEN, CRON_SECRET, and APP_URL before running.");
  process.exit(1);
}

const destination = `${appUrl}/api/agent/cron?max=25`;
// QStash: POST /v2/schedules/{destination}
const url = `https://qstash.upstash.io/v2/schedules/${encodeURIComponent(destination)}`;

const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Upstash-Cron": "* * * * *",
    "Upstash-Forward-Authorization": `Bearer ${secret}`,
    "Upstash-Method": "POST",
    "Content-Type": "application/json",
  },
  body: "{}",
});

const text = await res.text();
console.log("HTTP", res.status);
console.log(text);
if (!res.ok) {
  console.error("\nFailed. Check QSTASH_TOKEN and that destination is HTTPS.");
  process.exit(1);
}
console.log("\nOK — every minute QStash will POST:");
console.log(" ", destination);
console.log("See schedules: https://console.upstash.com/qstash");
