import { Router, Request, Response } from "express";
import { getManagersForClinic, getClinicsList } from "../../lib/twentyCrmClient.js";
import { getNextManagerIndex } from "../../lib/roundRobin.js";

const router = Router();

const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";
const LEADS_OBJECT = "leadss";
const META_DEFAULT_CLINIC_ID = process.env.META_DEFAULT_CLINIC_ID || "";

// Formatter for Twenty CRM Multi-Select / Select options
const formatCrmOption = (val: string) => {
  if (!val) return "";
  let formatted = val.toUpperCase().replace(/[- ]/g, "_");
  if (formatted === "YES_") return "YES";
  if (formatted === "NO_") return "NO";
  return formatted;
};

router.post("/", async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    console.log("[WP CF7] Received webhook:", JSON.stringify(payload, null, 2));

    const name = `${payload["your-name"] || ""} ${payload["last-name"] || ""}`.trim() || payload["full-name"] || "Website Lead";
    const email = payload["your-email"] || payload["email"] || "";
    const rawPhone = payload["your-tel"] || payload["full_number"] || payload["phone-number"] || "";
    
    // Clean and format phone number for Twenty CRM (requires E.164 format)
    let phone = rawPhone.replace(/[^0-9+]/g, '');
    if (phone.length === 10 && !phone.startsWith('+')) {
      phone = `+91${phone}`; // Default to India country code for 10-digit numbers
    } else if (phone.length > 0 && !phone.startsWith('+')) {
      phone = `+${phone}`;
    }
    
    // CF7 sometimes sends checkboxes/radios as arrays
    const rawLocation = payload["location"] || payload["preferred-location"];
    const location = Array.isArray(rawLocation) ? rawLocation[0] : (rawLocation || "");
    
    const message = payload["your-message"] || payload["how-we-help"] || "";
    const rawConcern = payload["primary-concern"];
    const primaryGoal = Array.isArray(rawConcern) ? rawConcern[0] : rawConcern;
    
    // Differentiate between Aayna and Akara based on payload structure
    let source = "WEBSITE_AAYNA_CLINIC"; // default
    if (payload["your-name"] || payload["location"] || payload["your-tel"]) {
      source = "WEBSITE_AKARA_WELLNESS";
    }

    const formid = payload["_wpcf7"] || "";

    console.log(`[WP CF7] Processing lead: ${name} | ${email} | ${phone} | source: ${source} | formid: ${formid}`);

    // ── Round-robin manager assignment ──
    let clinicId = META_DEFAULT_CLINIC_ID;

    if (location) {
      try {
        const normalize = (str: string) => str.toLowerCase().replace(/[\s_-]/g, '');
        const locStr = normalize(location);
        const clinics = await getClinicsList();
        const matchedClinic = clinics.find((c: any) => {
          const cName = normalize(c.name);
          return cName.includes(locStr) || locStr.includes(cName);
        });
        
        if (matchedClinic) {
          clinicId = matchedClinic.id;
          console.log(`[WP CF7] Dynamically matched clinic: ${matchedClinic.name} (${clinicId})`);
        } else {
          console.warn(`[WP CF7] Could not find clinic matching "${location}". Falling back to default.`);
        }
      } catch (e) {
        console.error("[WP CF7] Error fetching clinics list:", e);
      }
    }

    let managerId: string | null = null;

    if (clinicId) {
      try {
        const managers = await getManagersForClinic(clinicId);
        if (managers.length > 0) {
          const idx = await getNextManagerIndex(clinicId, managers.length);
          managerId = managers[idx].id;
          console.log(`[WP CF7] Round-robin assigned manager: ${managers[idx].name} (${managerId})`);
        }
      } catch (e) {
        console.error("[WP CF7] Manager assignment failed:", e);
      }
    }

    // ── Create via REST API directly ──
    const leadPayload: Record<string, any> = {
      name,
      email: { primaryEmail: email },
      phone: { primaryPhoneNumber: phone },
      stage: "REQUIREMENTS_GATHERED",
      source1: [source],
      formid: formid,
      ...(primaryGoal && { primarygoal: primaryGoal }),
      ...(clinicId && { clinicId: clinicId }),
      ...(managerId && { relationshipManagerId: managerId })
    };

    const response = await fetch(`${TWENTY_API_URL}/${LEADS_OBJECT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TWENTY_API_KEY}` },
      body: JSON.stringify(leadPayload),
    });

    if (response.ok) {
      const result = await response.json();
      const newId = result?.data?.id || result?.id;
      console.log(`[WP CF7] ✅ Lead "${name}" created successfully. ID: ${newId}`);
      
      // If there's a custom message, we can optionally append it as a note or just drop it.
      // For now, it's just created.

      res.status(200).json({ success: true, leadId: newId });
    } else {
      const errorText = await response.text();
      console.error(`[WP CF7] REST API creation failed (${response.status}):`, errorText);
      res.status(500).json({ success: false, reason: errorText });
    }
  } catch (e: any) {
    console.error("[WP CF7] Webhook handler error:", e.message);
    res.status(500).json({ success: false, reason: e.message });
  }
});

export default router;
