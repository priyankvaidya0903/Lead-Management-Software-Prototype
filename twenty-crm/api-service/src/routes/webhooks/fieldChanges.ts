/**
 * Field Change Tracker Webhook
 *
 * Listens for Lead record updates from Twenty CRM workflows.
 * Compares new values with cached snapshots to detect what changed,
 * then creates a "📋 Change Log" Note on the lead showing:
 *   "Clinic: Delhi → Ludhiana"
 *   "Manager: Priyank → Vansh"
 *
 * Twenty Workflow Setup:
 *   Trigger: Record Updated → Leads
 *   Action: Webhook POST to /crm-api/webhooks/field-changes
 *   Headers: id, clinics_id, relationship_manager_id, status, name
 */

import { Router, Request, Response } from "express";

const router = Router();

// ── In-memory snapshot cache ─────────────────────────────────────────────────
// Maps leadId → { fieldName: lastKnownValue }
// Survives as long as the process runs. For production, swap to Redis.
const leadSnapshots = new Map<string, Record<string, string>>();

// Fields we track for change logging
const TRACKED_FIELDS = ["clinics_id", "relationship_manager_id", "status", "name"];

// Human-readable labels for field names
const FIELD_LABELS: Record<string, string> = {
  clinics_id: "Clinic",
  relationship_manager_id: "Relationship Manager",
  status: "Stage",
  name: "Name",
};

/**
 * Resolve a Twenty CRM record ID to a human-readable name.
 * e.g. clinics_id "abc-123" → "Ludhiana"
 */
async function resolveIdToName(field: string, id: string): Promise<string> {
  if (!id) return "(empty)";

  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return id;

  try {
    let endpoint = "";
    if (field === "clinics_id") endpoint = `clinicss/${id}`;
    else if (field === "relationship_manager_id") endpoint = `managerss/${id}`;
    else return id; // Non-relational fields — return raw value

    const res = await fetch(`${apiUrl}/${endpoint}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return id;

    const data = await res.json();
    const record = data?.data ?? data;
    return record?.name || record?.title || id;
  } catch {
    return id;
  }
}

/**
 * Format a stage enum value to human-readable text.
 * e.g. "NOT_PICKING_UP" → "Not Picking Up"
 */
function formatStageValue(val: string): string {
  if (!val) return "(empty)";
  return val
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Create a change log note on a lead showing what changed.
 */
async function createChangeLogNote(leadId: string, changes: string[]): Promise<boolean> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return false;

  try {
    // Look for existing "📋 Change Log" note to append to
    let changeLogNote: any = null;
    const targetRes = await fetch(
      `${apiUrl}/noteTargets?filter=targetLeadsId[eq]:${leadId}&limit=10`,
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );

    if (targetRes.ok) {
      const targetData = await targetRes.json();
      const targets =
        targetData?.data?.noteTargets ?? targetData?.noteTargets ?? targetData?.data ?? [];

      for (const target of targets) {
        if (!target.noteId) continue;
        const noteRes = await fetch(`${apiUrl}/notes/${target.noteId}`, {
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        });
        if (!noteRes.ok) continue;
        const noteData = await noteRes.json();
        const note = noteData?.data?.note ?? noteData?.note ?? noteData?.data ?? noteData;
        if (note?.title === "📋 Change Log") {
          changeLogNote = note;
          break;
        }
      }
    }

    const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const changeText = `[${timestamp}]\n${changes.join("\n")}`;

    if (changeLogNote) {
      // Append to existing change log
      let blocks: any[] = [];
      try {
        if (typeof changeLogNote.bodyV2?.blocknote === "string") {
          blocks = JSON.parse(changeLogNote.bodyV2.blocknote);
        } else if (Array.isArray(changeLogNote.bodyV2?.blocknote)) {
          blocks = changeLogNote.bodyV2.blocknote;
        }
      } catch {
        blocks = [];
      }

      // Add a separator + new change entry
      blocks.push({ type: "paragraph", content: "───────────────────" });
      blocks.push({ type: "paragraph", content: changeText });

      await fetch(`${apiUrl}/notes/${changeLogNote.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyV2: { blocknote: JSON.stringify(blocks) },
        }),
      });
      console.log(`[FieldChanges] Appended to existing Change Log for lead ${leadId}`);
      return true;
    } else {
      // Create new change log note
      const response = await fetch(`${apiUrl}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "📋 Change Log",
          bodyV2: {
            blocknote: JSON.stringify([{ type: "paragraph", content: changeText }]),
          },
        }),
      });

      const noteData = await response.json();
      if (!response.ok) {
        console.error("[FieldChanges] Note creation failed:", noteData);
        return false;
      }

      // Link note to lead via GraphQL
      const noteId =
        noteData?.data?.createNote?.id ??
        noteData?.data?.notes?.id ??
        noteData?.data?.id ??
        noteData?.id;

      if (noteId) {
        const graphqlUrl = apiUrl.replace("/rest", "/graphql");
        await fetch(graphqlUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation {
                createNoteTarget(data: {
                  noteId: "${noteId}",
                  targetLeadsId: "${leadId}"
                }) {
                  id
                }
              }
            `,
          }),
        });
      }
      console.log(`[FieldChanges] Created new Change Log note for lead ${leadId}`);
      return true;
    }
  } catch (e) {
    console.error("[FieldChanges] Error creating change log note:", e);
    return false;
  }
}

// ─── WEBHOOK ENDPOINT ────────────────────────────────────────────────────────

router.post("/", async (req: Request, res: Response) => {
  try {
    const payload: any = req.body || {};
    const leadId = (req.headers["id"] as string) || payload?.id;

    if (!leadId) {
      return res.status(400).json({ error: "Missing lead id" });
    }

    const currentValues: Record<string, string> = {};
    for (const field of TRACKED_FIELDS) {
      // Nginx drops headers with underscores by default! We must use dashes for headers.
      const headerKey = field.replace(/_/g, "-"); 
      const val = (req.headers[headerKey] as string) || payload?.[field] || "";
      if (val) currentValues[field] = val;
    }

    console.log(`[FieldChanges] Webhook received for lead ${leadId}:`, currentValues);

    // Get previous snapshot
    const previousValues = leadSnapshots.get(leadId) || {};

    // Detect changes
    const changes: string[] = [];
    for (const field of TRACKED_FIELDS) {
      const newVal = currentValues[field];
      const oldVal = previousValues[field];

      if (!newVal) continue; // Field not sent in this webhook
      if (newVal === oldVal) continue; // No change

      // Resolve IDs to human-readable names
      let oldName: string;
      let newName: string;

      if (field === "clinics_id" || field === "relationship_manager_id") {
        [oldName, newName] = await Promise.all([
          oldVal ? resolveIdToName(field, oldVal) : Promise.resolve("(none)"),
          resolveIdToName(field, newVal),
        ]);
      } else if (field === "status") {
        oldName = oldVal ? formatStageValue(oldVal) : "(none)";
        newName = formatStageValue(newVal);
      } else {
        oldName = oldVal || "(none)";
        newName = newVal;
      }

      const label = FIELD_LABELS[field] || field;
      changes.push(`${label}: ${oldName} → ${newName}`);
    }

    if (changes.length === 0) {
      // First time seeing this lead or no tracked fields changed
      if (Object.keys(previousValues).length === 0) {
        console.log(`[FieldChanges] First snapshot cached for lead ${leadId}. No diff to log.`);
      } else {
        console.log(`[FieldChanges] No tracked field changes detected for lead ${leadId}.`);
      }
      // Update snapshot
      leadSnapshots.set(leadId, { ...previousValues, ...currentValues });
      return res.json({ success: true, message: "Snapshot updated, no changes detected" });
    }

    console.log(`[FieldChanges] Detected ${changes.length} change(s) for lead ${leadId}:`, changes);

    // Create/append the change log note
    await createChangeLogNote(leadId, changes);

    // Update the snapshot with new values
    leadSnapshots.set(leadId, { ...previousValues, ...currentValues });

    res.json({ success: true, changes });
  } catch (error) {
    console.error("[FieldChanges] Error processing webhook:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

/**
 * GET /crm-api/webhooks/field-changes/seed/:leadId
 * Seeds the cache with a lead's current state (call once per lead to establish baseline).
 */
router.get("/seed/:leadId", async (req: Request, res: Response) => {
  const leadId = req.params.leadId as string;
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;

  if (!apiKey) return res.status(500).json({ error: "API key not set" });

  try {
    const response = await fetch(`${apiUrl}/leadss/${leadId}`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    if (!response.ok) return res.status(404).json({ error: "Lead not found" });

    const data = await response.json();
    const lead = data?.data?.leadss ?? data?.leadss ?? data?.data ?? data;

    const snapshot: Record<string, string> = {};
    if (lead?.clinicsId) snapshot.clinics_id = lead.clinicsId;
    if (lead?.relationshipManagerId) snapshot.relationship_manager_id = lead.relationshipManagerId;
    if (lead?.status) snapshot.status = lead.status;
    if (lead?.name) snapshot.name = lead.name;

    leadSnapshots.set(leadId, snapshot);
    console.log(`[FieldChanges] Seeded snapshot for lead ${leadId}:`, snapshot);

    res.json({ success: true, snapshot });
  } catch (e) {
    console.error("[FieldChanges] Error seeding lead snapshot:", e);
    res.status(500).json({ error: "Failed to seed" });
  }
});

/**
 * GET /crm-api/webhooks/field-changes/seed-all
 * Seeds the cache for ALL leads (run once on startup or on-demand).
 */
router.get("/seed-all", async (_req: Request, res: Response) => {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;

  if (!apiKey) return res.status(500).json({ error: "API key not set" });

  try {
    const response = await fetch(`${apiUrl}/leadss?limit=200`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    if (!response.ok) return res.status(500).json({ error: "Failed to fetch leads" });

    const data = await response.json();
    const leads = data?.data?.leadss ?? data?.leadss ?? data?.data ?? [];

    let seeded = 0;
    for (const lead of leads) {
      const snapshot: Record<string, string> = {};
      if (lead?.clinicsId) snapshot.clinics_id = lead.clinicsId;
      if (lead?.relationshipManagerId)
        snapshot.relationship_manager_id = lead.relationshipManagerId;
      if (lead?.status) snapshot.status = lead.status;
      if (lead?.name) snapshot.name = lead.name;

      leadSnapshots.set(lead.id, snapshot);
      seeded++;
    }

    console.log(`[FieldChanges] Seeded snapshots for ${seeded} leads.`);
    res.json({ success: true, seeded });
  } catch (e) {
    console.error("[FieldChanges] Error seeding all leads:", e);
    res.status(500).json({ error: "Failed to seed" });
  }
});

export default router;
