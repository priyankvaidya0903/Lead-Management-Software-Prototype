#!/usr/bin/env ts-node
/**
 * register-webhook.ts
 *
 * One-shot script to register the Twenty CRM webhook for task.created events.
 * Run once after setting up your .env.local:
 *
 *   npx ts-node --project tsconfig.json scripts/register-webhook.ts
 *
 * To delete an existing webhook:
 *   npx ts-node --project tsconfig.json scripts/register-webhook.ts --delete <webhookId>
 */

import * as fs from "fs";
import * as path from "path";

// Load .env.local manually (ts-node doesn't load it automatically)
function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env.local");
  if (!fs.existsSync(envPath)) {
    console.error(".env.local not found at", envPath);
    process.exit(1);
  }
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] = rest.join("=").trim();
  }
}

loadEnv();

const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";
const TWENTY_WEBHOOK_SECRET = process.env.TWENTY_WEBHOOK_SECRET || "";

// The URL Twenty CRM will POST to. Uses host.docker.internal so the Docker
// container can reach the Next.js dev server running on the host machine.
const WEBHOOK_TARGET_URL =
  process.env.WEBHOOK_TARGET_URL ||
  "http://host.docker.internal:3001/api/webhooks/twenty-tasks";

if (!TWENTY_API_KEY) {
  console.error("❌ TWENTY_API_KEY is not set in .env.local");
  process.exit(1);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TWENTY_API_KEY}`,
};

async function listWebhooks() {
  const res = await fetch(`${TWENTY_API_URL}/webhooks`, { headers });
  return res.json() as Promise<Array<{ id: string; targetUrl: string; operations: string[] }>>;
}

async function registerWebhook() {
  console.log("🔗 Registering Twenty CRM webhook...");
  console.log(`   Target URL : ${WEBHOOK_TARGET_URL}`);
  console.log(`   Operation  : task.created`);

  // Check for an existing webhook pointing at the same URL to avoid duplicates
  const existing = await listWebhooks();
  const duplicate = existing.find((w) => w.targetUrl === WEBHOOK_TARGET_URL);
  if (duplicate) {
    console.log(`⚠️  Webhook already exists (id: ${duplicate.id}). Skipping registration.`);
    console.log("   Delete it first with: npx ts-node scripts/register-webhook.ts --delete", duplicate.id);
    return;
  }

  const body: Record<string, unknown> = {
    targetUrl: WEBHOOK_TARGET_URL,
    operations: ["task.created"],
  };
  if (TWENTY_WEBHOOK_SECRET) {
    body.secret = TWENTY_WEBHOOK_SECRET;
  } else {
    console.warn("⚠️  TWENTY_WEBHOOK_SECRET not set — webhook will not be HMAC-signed");
  }

  const res = await fetch(`${TWENTY_API_URL}/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("❌ Failed to register webhook:", data);
    process.exit(1);
  }

  console.log("✅ Webhook registered successfully!");
  console.log(`   ID         : ${data.id}`);
  console.log(`   Target URL : ${data.targetUrl}`);
  console.log(`   Operations : ${data.operations?.join(", ")}`);
}

async function deleteWebhook(id: string) {
  console.log(`🗑️  Deleting webhook ${id}...`);
  const res = await fetch(`${TWENTY_API_URL}/webhooks/${id}`, {
    method: "DELETE",
    headers,
  });
  if (res.ok) {
    console.log("✅ Webhook deleted.");
  } else {
    console.error("❌ Failed to delete webhook:", await res.text());
  }
}

// CLI entry point
const args = process.argv.slice(2);
if (args[0] === "--delete" && args[1]) {
  deleteWebhook(args[1]).catch(console.error);
} else {
  registerWebhook().catch(console.error);
}
