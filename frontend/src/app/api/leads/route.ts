import { NextResponse } from "next/server";
import { getManagersForClinic } from "@/lib/twentyCrmClient";
import { getNextManagerIndex } from "@/lib/roundRobin";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let { clinicId, name, email, phone, treatment, source } = body;

    // Map source for Twenty CRM multi-select field
    if (source) {
      const lowerSource = String(source).toLowerCase();
      if (lowerSource.includes("google") || lowerSource.includes("gads")) {
        source = "GOOGLE_ADS";
      } else if (lowerSource.includes("facebook") || lowerSource.includes("fb") || lowerSource.includes("meta")) {
        source = "FACEBOOK_ADS";
      } 
      // If it doesn't match, we will just pass the raw source (e.g. "Organic") 
      // directly to the CRM so it shows up in the payload.
    }

    // Map treatment for Twenty CRM multi-select field (convert to uppercase internal values)
    if (treatment) {
      // If it's a string from the frontend dropdown, convert it to uppercase with underscores
      // e.g. "General Consultation" -> "GENERAL_CONSULTATION"
      const formattedTreatment = String(treatment).toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
      treatment = formattedTreatment;
    }

    // Validate the incoming data
    if (!name || !email || !phone) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const TWENTY_API_URL = process.env.TWENTY_API_URL;
    const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
    // Force the plural 'leadss' regardless of the env variable because Twenty CRM requires it.
    const LEADS_OBJECT = "leadss";

    // ─── Duplicate Check & Upsert Logic ───────────────────────────────────────
    let existingLeadId = null;

    if (TWENTY_API_URL && TWENTY_API_KEY) {
      try {
        console.log(`[Leads API] Checking for existing lead with email: ${email}`);
        const filterParam = encodeURIComponent(`email.primaryEmail[eq]:${email}`);
        const searchUrl = `${TWENTY_API_URL}/${LEADS_OBJECT}?filter=${filterParam}`;

        const searchRes = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TWENTY_API_KEY}`
          }
        });

        if (searchRes.ok) {
          const data = await searchRes.json();
          // Extract records based on possible Twenty CRM response structures
          const records = data?.data?.[LEADS_OBJECT] || data?.[LEADS_OBJECT] || data?.data || [];

          if (Array.isArray(records) && records.length > 0) {
            existingLeadId = records[0].id;
            console.log(`[Leads API] Found existing lead with ID: ${existingLeadId}`);
          }
        } else {
          console.error(`[Leads API] Search failed: ${searchRes.statusText}`);
        }
      } catch (err) {
        console.error("[Leads API] Error during duplicate check:", err);
      }
    }

    // If lead exists, update the Stage to bring them to the top
    if (existingLeadId && TWENTY_API_URL && TWENTY_API_KEY) {
      try {
        const updateUrl = `${TWENTY_API_URL}/${LEADS_OBJECT}/${existingLeadId}`;
        const updateRes = await fetch(updateUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TWENTY_API_KEY}`
          },
          body: JSON.stringify({
            stage: "REPEAT_INQUIRY", // Update the stage to flag as a repeat customer using the internal value
            ...(source && { source }),
            ...(treatment && { treatment }),
          })
        });

        if (updateRes.ok) {
          console.log("[Leads API] Successfully updated existing lead's Stage to 'REPEAT_INQUIRY'");
          return NextResponse.json({ success: true, message: "Existing lead updated" });
        } else {
          console.error(`[Leads API] Failed to update existing lead: ${updateRes.statusText}`);
        }
      } catch (err) {
        console.error("[Leads API] Error updating existing lead:", err);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // If no existing lead was found, proceed with creating a NEW lead via Webhook
    const TWENTY_WEBHOOK_URL = process.env.TWENTY_WORKFLOW_WEBHOOK_URL;

    if (!TWENTY_WEBHOOK_URL) {
      console.warn("[Leads API] TWENTY_WORKFLOW_WEBHOOK_URL is not set.");
      console.log("[Leads API] Lead captured (not yet synced to CRM):", {
        clinicId, name, email, phone, treatment, source,
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
        const managers = await getManagersForClinic(clinicId);

        if (managers.length > 0) {
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
        console.error(
          "[Leads API] Manager round-robin failed (lead will still be captured):", err
        );
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Build the webhook payload
    const webhookPayload: Record<string, unknown> = {
      name,
      email,
      phone,
      clinicId,
      ...(treatment && { treatment }),
      ...(source && { source }),
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

    console.log("[Leads API] New lead successfully sent to Twenty CRM via webhook:", {
      name,
      email,
      clinicId,
      source,
      treatment,
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
