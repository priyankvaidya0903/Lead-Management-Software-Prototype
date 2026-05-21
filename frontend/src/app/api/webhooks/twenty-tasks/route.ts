import { NextResponse } from "next/server";

// This endpoint receives outbound webhook events from Twenty CRM.
// Twenty CRM is configured to POST here when records are created/updated/deleted.
// Configured URL in Twenty: http://host.docker.internal:3001/api/webhooks/twenty-tasks

interface TwentyWebhookPayload {
  targetObject: string;       // e.g. "lead", "task", "person"
  action: string;             // e.g. "created", "updated", "deleted"
  record: Record<string, any>; // The full record object from Twenty CRM
  updatedFields?: string[];   // Present on "updated" events
}

export async function POST(req: Request) {
  try {
    const payload: TwentyWebhookPayload = await req.json();

    const { targetObject, action, record } = payload;

    console.log(`[Twenty Webhook] Received: ${targetObject}.${action}`, {
      recordId: record?.id,
      record,
    });

    // Route to the appropriate handler based on object type + action
    if (targetObject === "lead" && action === "created") {
      await handleLeadCreated(record);
    } else if (targetObject === "task" && action === "created") {
      await handleTaskCreated(record);
    } else {
      // Catch-all: log unhandled events for future use
      console.log(`[Twenty Webhook] Unhandled event: ${targetObject}.${action}`);
    }

    // Always return 200 quickly so Twenty CRM doesn't retry or mark as failed
    return NextResponse.json({ received: true }, { status: 200 });

  } catch (error) {
    console.error("[Twenty Webhook] Error processing webhook:", error);
    // Return 200 even on internal errors to prevent Twenty from retrying
    // Log the error internally instead
    return NextResponse.json({ received: true, error: "Processing failed internally" }, { status: 200 });
  }
}

/**
 * Handle a new lead being created in Twenty CRM.
 * Extend this to trigger email notifications, Slack alerts, Google Sheets sync, etc.
 */
async function handleLeadCreated(record: Record<string, any>) {
  console.log("[Twenty Webhook] New Lead Created:", {
    id: record.id,
    name: record.name,
    email: record.email?.primaryEmail,
    phone: record.phone?.primaryPhoneNumber,
    createdAt: record.createdAt,
  });

  // TODO: Add downstream actions here, for example:
  // - Send a welcome email via Resend/SendGrid
  // - Post a Slack notification to your sales channel
  // - Log to Google Analytics / a data warehouse
  // - Assign a sales rep automatically
}

/**
 * Handle a new task being created in Twenty CRM.
 * Extend this to trigger reminders, calendar events, etc.
 */
async function handleTaskCreated(record: Record<string, any>) {
  console.log("[Twenty Webhook] New Task Created:", {
    id: record.id,
    title: record.title,
    status: record.status,
    dueAt: record.dueAt,
    assigneeId: record.assigneeId,
    createdAt: record.createdAt,
  });

  // TODO: Add downstream actions here, for example:
  // - Create a Google Calendar event for the task due date
  // - Send a reminder notification to the assigned user
}
