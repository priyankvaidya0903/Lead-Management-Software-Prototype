/**
 * Meta Lead Ads Webhook
 *
 * Receives lead form submissions from Facebook/Instagram Lead Ads via
 * Meta's Webhooks API. When a user fills a lead form on your ad,
 * Meta sends a real-time notification here, we fetch the full lead
 * data from the Graph API, and create a Lead in Twenty CRM.
 *
 * Flow:
 *   1. Meta sends { entry[].changes[].value.leadgen_id } to POST /
 *   2. We call Graph API to fetch full lead data (name, email, phone, etc.)
 *   3. We call the existing /crm-api/leads endpoint to create the lead in CRM
 *
 * Env vars:
 *   META_APP_SECRET          — Meta App Secret (for signature verification)
 *   META_LEADS_ACCESS_TOKEN  — Page access token with leads_retrieval permission
 *   META_LEADS_VERIFY_TOKEN  — Webhook verification token (you choose this)
 *   META_DEFAULT_CLINIC_ID   — Default clinic ID to assign leads to
 */
import { Router, Request, Response } from "express";
import crypto from "node:crypto";
import { getManagersForClinic } from "../../lib/twentyCrmClient.js";
import { getNextManagerIndex } from "../../lib/roundRobin.js";

const router = Router();

const META_LEADS_VERIFY_TOKEN = process.env.META_LEADS_VERIFY_TOKEN || "meta_leads_verify_token_123";
const META_LEADS_ACCESS_TOKEN = process.env.META_LEADS_ACCESS_TOKEN || process.env.META_WHATSAPP_ACCESS_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_DEFAULT_CLINIC_ID = process.env.META_DEFAULT_CLINIC_ID || "";

// ─── Webhook Verification (GET) ─────────────────────────────────────────────
// Meta sends a GET request to verify your webhook URL when you first subscribe.
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === META_LEADS_VERIFY_TOKEN) {
    console.log("[Meta Leads] ✅ Webhook verification successful!");
    res.status(200).send(challenge);
  } else {
    console.warn("[Meta Leads] ❌ Webhook verification failed. Token mismatch.");
    res.status(403).send("Forbidden");
  }
});

// ─── Signature Verification ─────────────────────────────────────────────────
function verifySignature(req: Request): boolean {
  if (!META_APP_SECRET) return true; // Skip if not configured

  const signature = req.headers["x-hub-signature-256"] as string;
  if (!signature) {
    console.warn("[Meta Leads] No signature header found. Skipping verification.");
    return true; // Allow for now — tighten in production
  }

  const body = JSON.stringify(req.body);
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(body).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Fetch Lead Data from Graph API ─────────────────────────────────────────
interface MetaLeadField {
  name: string;
  values: string[];
}

async function fetchLeadData(leadgenId: string): Promise<Record<string, string> | null> {
  if (!META_LEADS_ACCESS_TOKEN) {
    console.error("[Meta Leads] META_LEADS_ACCESS_TOKEN not set — cannot fetch lead data.");
    return null;
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${META_LEADS_ACCESS_TOKEN}`;
    console.log(`[Meta Leads] Fetching lead data for leadgen_id: ${leadgenId}`);

    const response = await fetch(url);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Meta Leads] Graph API error (${response.status}):`, errorText);
      return null;
    }

    const data = await response.json();
    console.log(`[Meta Leads] Raw Graph API response:`, JSON.stringify(data, null, 2));

    // Parse field_data array into a simple key-value map
    const fields: Record<string, string> = {};
    if (data.field_data) {
      for (const field of data.field_data as MetaLeadField[]) {
        fields[field.name.toLowerCase()] = field.values?.[0] || "";
      }
    }

    // Also capture the ad/form metadata
    if (data.ad_id) fields._ad_id = data.ad_id;
    if (data.form_id) fields._form_id = data.form_id;
    if (data.campaign_id) fields._campaign_id = data.campaign_id;
    if (data.adgroup_id) fields._adgroup_id = data.adgroup_id;

    return fields;
  } catch (e: any) {
    console.error("[Meta Leads] Failed to fetch lead data:", e.message);
    return null;
  }
}

// ─── Create Lead in Twenty CRM ──────────────────────────────────────────────
async function createLeadInCRM(leadData: Record<string, string>) {
  const TWENTY_API_URL = process.env.TWENTY_API_URL;
  const TWENTY_API_KEY = process.env.TWENTY_API_KEY;
  const TWENTY_WEBHOOK_URL = process.env.TWENTY_WORKFLOW_WEBHOOK_URL;
  const LEADS_OBJECT = "leadss";

  if (!TWENTY_API_URL || !TWENTY_API_KEY) {
    console.error("[Meta Leads] TWENTY_API_URL or TWENTY_API_KEY not set.");
    return { success: false, reason: "CRM not configured" };
  }

  // Extract fields from Meta lead form
  const name = leadData.full_name || leadData.name || `${leadData.first_name || ""} ${leadData.last_name || ""}`.trim() || "Meta Lead";
  const email = leadData.email || "";
  const phone = leadData.phone_number || leadData.phone || "";
  const city = leadData.city || "";

  // Map source
  const source = "FACEBOOK_ADS";

  // Custom EmSculpt Form Fields
  const targetArea = leadData["q1._which_area_would_you_like_to_target?"] || leadData["which_area_are_you_looking_to_target?"] || "";
  const primaryGoal = leadData["q2._what_is_your_primary_goal?"] || "";
  const planningToStart = leadData["q3._when_are_you_planning_to_start?"] || "";
  const previousTreatment = leadData["q4._have_you_tried_body_contouring_treatments_before?"] || "";
  const preferredLocation = leadData["select_your_preferred_location"] || "";
  const budget = leadData["preferred_transformation_budget"] || "";

  // Determine treatment if present in form
  let treatment = leadData.treatment || leadData.service || leadData.interest || "";
  if (treatment) {
    treatment = treatment.toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
  }

  console.log(`[Meta Leads] Processing lead: ${name} | ${email} | ${phone} | source: ${source}`);

  // ── Duplicate check ──
  if (email) {
    try {
      const filterParam = encodeURIComponent(`email.primaryEmail[eq]:${email}`);
      const searchUrl = `${TWENTY_API_URL}/${LEADS_OBJECT}?filter=${filterParam}`;
      const searchRes = await fetch(searchUrl, {
        method: "GET",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TWENTY_API_KEY}` },
      });

      if (searchRes.ok) {
        const data = await searchRes.json();
        const records = data?.data?.[LEADS_OBJECT] || data?.[LEADS_OBJECT] || data?.data || [];
        if (Array.isArray(records) && records.length > 0) {
          console.log(`[Meta Leads] Duplicate found — updating existing lead ${records[0].id}`);
          await fetch(`${TWENTY_API_URL}/${LEADS_OBJECT}/${records[0].id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${TWENTY_API_KEY}` },
            body: JSON.stringify({
              stage: "REPEAT_INQUIRY",
              source,
              ...(treatment && { treatment }),
            }),
          });
          return { success: true, action: "updated", leadId: records[0].id };
        }
      }
    } catch (e) {
      console.error("[Meta Leads] Duplicate check failed:", e);
    }
  }

  // ── Round-robin manager assignment ──
  const clinicId = META_DEFAULT_CLINIC_ID;
  let managerId: string | null = null;

  if (clinicId) {
    try {
      const managers = await getManagersForClinic(clinicId);
      if (managers.length > 0) {
        const idx = await getNextManagerIndex(clinicId, managers.length);
        managerId = managers[idx].id;
        console.log(`[Meta Leads] Round-robin assigned manager: ${managers[idx].name} (${managerId})`);
      }
    } catch (e) {
      console.error("[Meta Leads] Manager assignment failed:", e);
    }
  }

  // ── Create via Webhook (if configured) ──
  if (TWENTY_WEBHOOK_URL) {
    try {
      const webhookPayload: Record<string, unknown> = {
        name,
        email,
        phone,
        source,
        ...(clinicId && { clinicId }),
        ...(treatment && { treatment }),
        ...(managerId && { managerId }),
        ...(leadData._campaign_id && { campaignId: leadData._campaign_id }),
        ...(leadData._ad_id && { adId: leadData._ad_id }),
        ...(targetArea && { targetArea }),
        ...(primaryGoal && { primaryGoal }),
        ...(planningToStart && { planningToStart }),
        ...(previousTreatment && { previousTreatment }),
        ...(preferredLocation && { preferredLocation }),
        ...(budget && { budget }),
      };

      const response = await fetch(TWENTY_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookPayload),
      });

      if (response.ok) {
        console.log(`[Meta Leads] ✅ Lead "${name}" sent to Twenty CRM via workflow webhook.`);
        return { success: true, action: "created_via_webhook" };
      } else {
        console.error(`[Meta Leads] Webhook failed (${response.status}):`, await response.text());
      }
    } catch (e) {
      console.error("[Meta Leads] Webhook delivery failed:", e);
    }
  }

  // ── Fallback: Create via REST API directly ──
  try {
    const leadPayload: Record<string, any> = {
      name,
      email: { primaryEmail: email },
      phone: { primaryPhoneNumber: phone, primaryPhoneCallingCode: "+91" },
      source,
      stage: "NEW",
      ...(treatment && { treatment }),
      ...(clinicId && { clinicsId: clinicId }),
      ...(managerId && { relationshipManagerId: managerId }),
      ...(leadData._campaign_id && { campaignId: leadData._campaign_id }),
      ...(leadData._ad_id && { adId: leadData._ad_id }),
      ...(targetArea && { targetArea }),
      ...(primaryGoal && { primaryGoal }),
      ...(planningToStart && { planningToStart }),
      ...(previousTreatment && { previousTreatment }),
      ...(preferredLocation && { preferredLocation }),
      ...(budget && { budget }),
    };

    const response = await fetch(`${TWENTY_API_URL}/${LEADS_OBJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TWENTY_API_KEY}` },
      body: JSON.stringify(leadPayload),
    });

    if (response.ok) {
      const result = await response.json();
      const newId = result?.data?.id || result?.id;
      console.log(`[Meta Leads] ✅ Lead "${name}" created directly via REST API. ID: ${newId}`);
      return { success: true, action: "created_via_rest", leadId: newId };
    } else {
      const errorText = await response.text();
      console.error(`[Meta Leads] REST API creation failed (${response.status}):`, errorText);
      return { success: false, reason: errorText };
    }
  } catch (e: any) {
    console.error("[Meta Leads] REST API creation error:", e.message);
    return { success: false, reason: e.message };
  }
}

// ─── Webhook Handler (POST) ─────────────────────────────────────────────────
// Meta sends a POST with leadgen events when someone fills your lead form.
router.post("/", async (req: Request, res: Response) => {
  // IMMEDIATELY respond with 200 — Meta requires this within 20 seconds
  // or it will retry and eventually disable your webhook.
  res.status(200).json({ received: true });

  try {
    // Verify signature (optional but recommended)
    if (!verifySignature(req)) {
      console.error("[Meta Leads] ❌ Invalid signature! Ignoring request.");
      return;
    }

    const payload = req.body;
    console.log(`[Meta Leads] Received webhook:`, JSON.stringify(payload, null, 2));

    if (payload?.object !== "page") {
      console.log("[Meta Leads] Not a page event, ignoring.");
      return;
    }

    // Process each entry (usually just one)
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "leadgen") continue;

        const leadgenId = change.value?.leadgen_id;
        if (!leadgenId) {
          console.warn("[Meta Leads] No leadgen_id in change value. Skipping.");
          continue;
        }

        console.log(`[Meta Leads] Processing leadgen_id: ${leadgenId}`);

        // Fetch full lead data from Graph API
        const leadData = await fetchLeadData(leadgenId);
        if (!leadData) {
          console.error(`[Meta Leads] Could not fetch data for leadgen_id: ${leadgenId}`);
          continue;
        }

        // Create lead in Twenty CRM
        const result = await createLeadInCRM(leadData);
        console.log(`[Meta Leads] Result for ${leadgenId}:`, result);
      }
    }
  } catch (e: any) {
    console.error("[Meta Leads] Webhook processing error:", e.message);
  }
});

// ─── Manual Test Endpoint ───────────────────────────────────────────────────
// POST /crm-api/webhooks/meta-leads/test with { name, email, phone }
router.post("/test", async (req: Request, res: Response) => {
  try {
    console.log("[Meta Leads] Manual test triggered with:", req.body);
    const result = await createLeadInCRM({
      full_name: req.body.name || "Test Meta Lead",
      email: req.body.email || "test@meta.com",
      phone_number: req.body.phone || "9999999999",
      ...(req.body.treatment && { treatment: req.body.treatment }),
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
