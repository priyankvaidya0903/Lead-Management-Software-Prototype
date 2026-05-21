import { NextResponse } from "next/server";
import { getManagersForClinic } from "@/lib/twentyCrmClient";
import { getNextManagerIndex } from "@/lib/roundRobin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { clinicId, name, email, phone } = body;

    // Validate the incoming data
    if (!name || !email || !phone) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Twenty CRM Workflow Webhook URL (Inbound Trigger)
    // No API key required — Twenty authenticates via the unique URL.
    const TWENTY_WEBHOOK_URL = process.env.TWENTY_WORKFLOW_WEBHOOK_URL;

    if (!TWENTY_WEBHOOK_URL) {
      console.warn("[Leads API] TWENTY_WORKFLOW_WEBHOOK_URL is not set.");
      console.log("[Leads API] Lead captured (not yet synced to CRM):", {
        clinicId, name, email, phone,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      return NextResponse.json({
        success: true,
        message: "Lead captured (webhook not configured — simulated)",
      });
    }

    // ─── Round-Robin Manager Assignment ───────────────────────────────────────
    let assignedManager: { id: string; name: string } | null = null;

    if (clinicId) {
      try {
        // 1. Fetch all managers for this clinic (cached for 60s)
        const managers = await getManagersForClinic(clinicId);

        if (managers.length > 0) {
          // 2. Get the next manager index atomically from Redis
          const managerIndex = await getNextManagerIndex(clinicId, managers.length);
          const manager = managers[managerIndex];

          assignedManager = {
            id: manager.id,
            name: manager.name ?? `Manager ${managerIndex + 1}`,
          };

          console.log(
            `[Leads API] Round-robin assigned manager [${managerIndex + 1}/${managers.length}]:`,
            assignedManager.name,
            `for clinic: ${clinicId}`
          );
        } else {
          console.warn(
            `[Leads API] No managers found for clinicId: ${clinicId}. ` +
            "Lead will be created without a manager assignment."
          );
        }
      } catch (err) {
        // Non-fatal: if manager lookup fails, still capture the lead
        console.error(
          "[Leads API] Manager round-robin failed (lead will still be captured):", err
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Build the webhook payload — include manager if one was assigned
    const webhookPayload: Record<string, unknown> = {
      name,
      email,
      phone,
      clinicId,
      ...(assignedManager && {
        managerId: assignedManager.id,
      }),
    };

    const response = await fetch(TWENTY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(webhookPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Leads API] Twenty CRM Webhook Error:", errorText);
      throw new Error("Failed to deliver lead to CRM webhook");
    }

    console.log("[Leads API] Lead successfully sent to Twenty CRM via webhook:", {
      name,
      email,
      clinicId,
      assignedManagerId: assignedManager?.id ?? "none",
    });

    return NextResponse.json({ success: true });

  } catch (error) {
    console.error("[Leads API] Lead capture error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
