import { NextResponse } from "next/server";
import crypto from "crypto";

const BOOKING_LINK = "https://calendar.app.google/ZNeBwHTpmscVzm3v7";

// Twenty CRM webhook payload shape for a task event
interface TwentyWebhookPayload {
  targetObjectNameSingular?: string; // e.g. "task"
  action?: string;                    // e.g. "created"
  record?: {
    id?: string;
    title?: string;
    body?: string;
    dueAt?: string | null;
    status?: string;
    [key: string]: unknown;
  };
  eventName?: string; // e.g. "task.created"
  objectMetadata?: { nameSingular?: string };
}

/**
 * Verify the HMAC-SHA256 signature that Twenty CRM attaches to every webhook.
 * If TWENTY_WEBHOOK_SECRET is not set, we skip verification with a warning.
 */
function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.TWENTY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[webhook] TWENTY_WEBHOOK_SECRET not set — skipping HMAC verification");
    return true;
  }
  if (!signatureHeader) {
    console.error("[webhook] Missing x-twenty-webhook-signature header");
    return false;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signatureHeader.replace(/^sha256=/, ""), "hex")
  );
}

/**
 * Patch the task body in Twenty CRM to append the booking link.
 * This way the manager sees the link directly in the CRM task view.
 */
async function appendBookingLinkToTask(taskId: string, existingMarkdown: string): Promise<void> {
  const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
  if (!TWENTY_API_KEY || !taskId) return;

  const bookingNote = `\n\n📅 **Schedule a 30-min call:** ${BOOKING_LINK}`;
  const newMarkdown = (existingMarkdown || "") + bookingNote;

  try {
    const res = await fetch(`${TWENTY_API_URL}/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TWENTY_API_KEY}`,
      },
      body: JSON.stringify({
        bodyV2: { markdown: newMarkdown },
      }),
    });
    if (res.ok) {
      console.log(`[webhook] ✅ Booking link appended to task ${taskId}`);
    } else {
      const err = await res.text();
      console.warn(`[webhook] Could not patch task body: ${err}`);
    }
  } catch (e) {
    console.warn("[webhook] Failed to patch task:", e);
  }
}

export async function POST(req: Request) {
  // Read raw body for signature verification
  const rawBody = await req.text();
  const signature = req.headers.get("x-twenty-webhook-signature");

  if (!verifySignature(rawBody, signature)) {
    console.error("[webhook] Invalid signature — rejecting request");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: TwentyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Determine the event type
  const eventName =
    payload.eventName ??
    `${payload.targetObjectNameSingular ?? ""}.${payload.action ?? ""}`;

  console.log(`[webhook] Received event: ${eventName}`, JSON.stringify(payload).slice(0, 300));

  // Only process task.created events
  if (!eventName.includes("task") || !eventName.includes("created")) {
    return NextResponse.json({ ok: true, skipped: true, reason: `Not a task.created event (got: ${eventName})` });
  }

  const record = payload.record;
  if (!record) {
    return NextResponse.json({ error: "No record in payload" }, { status: 400 });
  }

  const title = record.title || "Untitled Task";
  // bodyV2.markdown is the actual text field in Twenty CRM's tasks
  const bodyV2 = record.bodyV2 as { markdown?: string } | undefined;
  const existingMarkdown = bodyV2?.markdown || (typeof record.body === "string" ? record.body : "");
  const dueAt = record.dueAt || null;
  const taskId = record.id;

  console.log(`[webhook] ✅ task.created: "${title}" (id: ${taskId}, dueAt: ${dueAt ?? "none"})`);

  // Append the booking link to the task body in Twenty CRM
  if (taskId) {
    await appendBookingLinkToTask(taskId, existingMarkdown);
  }

  return NextResponse.json({
    ok: true,
    action: "booking_link_appended",
    bookingLink: BOOKING_LINK,
    task: { title, dueAt, taskId },
  });
}

// Reject non-POST methods
export async function GET() {
  return NextResponse.json({ status: "Twenty CRM webhook endpoint — POST only" }, { status: 405 });
}
