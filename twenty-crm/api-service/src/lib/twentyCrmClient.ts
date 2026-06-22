/**
 * Twenty CRM Client — Manager Query
 *
 * Fetches Relationship Managers from Twenty CRM for a given clinic.
 * Results are cached in-memory for CACHE_TTL_MS to avoid hammering the CRM API
 * on every lead submission.
 *
 * Configuration (via .env):
 *   TWENTY_API_URL              — e.g. http://localhost:3000/rest
 *   TWENTY_API_KEY              — Bearer token from Twenty CRM Settings → API Keys
 *   TWENTY_MANAGERS_OBJECT      — API name of the managers object (default: "managers")
 *   TWENTY_MANAGERS_CLINIC_FIELD — Field name linking manager to clinic (default: "clinicId")
 */

export interface Manager {
  id: string;
  name: string;
  [key: string]: unknown;
}

// In-memory cache: clinicId → { managers, fetchedAt }
const managerCache = new Map<string, { managers: Manager[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Fetches all Relationship Managers for a given clinicId from Twenty CRM.
 * Results are cached for 60 seconds.
 *
 * @param clinicId - The clinic to fetch managers for
 * @returns Array of Manager objects, or empty array if none found / API unavailable
 */
export async function getManagersForClinic(clinicId: string): Promise<Manager[]> {
  // Return cached result if still fresh
  const cached = managerCache.get(clinicId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    console.log(
      `[TwentyCRM] Cache hit for clinic ${clinicId}: ${cached.managers.length} manager(s)`
    );
    return cached.managers;
  }

  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  const objectName = process.env.TWENTY_MANAGERS_OBJECT || "managers";
  const clinicField = process.env.TWENTY_MANAGERS_CLINIC_FIELD || "clinicId";

  if (!apiKey) {
    console.warn(
      "[TwentyCRM] TWENTY_API_KEY is not set — cannot fetch managers. " +
      "Set it in .env: Settings → APIs & Webhooks → API Keys"
    );
    return [];
  }

  try {
    // Twenty CRM REST filter syntax: filter=field[eq]:value
    const filterParam = encodeURIComponent(`${clinicField}[eq]:${clinicId}`);
    const url = `${apiUrl}/${objectName}?filter=${filterParam}&orderBy=createdAt[AscNullsLast]`;

    console.log(`[TwentyCRM] Fetching managers for clinic ${clinicId} from: ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Timeout after 5 seconds
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[TwentyCRM] Failed to fetch managers (${response.status}):`, errorText);
      return [];
    }

    const data = await response.json();

    // Twenty CRM REST API wraps results in data.{objectName}
    // e.g. { data: { managers: [ {...}, {...} ] } }
    const rawManagers =
      data?.data?.[objectName] ??
      data?.[objectName] ??
      data?.data ??
      [];

    // Map raw data and include availability field
    const allManagers: Manager[] = rawManagers.map((m: any) => ({
      id: m.id,
      name: m.name,
      clinicId: m[clinicField],
      availability: m.availability,
    }));

    // Filter: only keep managers whose availability is "Yes" (or "YES", "yes")
    // If a manager has no availability field set, we INCLUDE them (backwards compatible)
    const managers = allManagers.filter((m: Manager) => {
      const avail = String(m.availability || "").toUpperCase();
      if (!m.availability) {
        console.log(`[TwentyCRM] Manager ${m.name} has no availability set — including by default`);
        return true;
      }
      if (avail === "YES") return true;
      console.log(`[TwentyCRM] Manager ${m.name} is unavailable (availability: ${m.availability}) — skipping`);
      return false;
    });

    console.log(
      `[TwentyCRM] Found ${allManagers.length} total manager(s), ${managers.length} available for clinic ${clinicId}`
    );

    // Store in cache (only available managers)
    managerCache.set(clinicId, { managers, fetchedAt: Date.now() });


    return managers;
  } catch (error) {
    console.error("[TwentyCRM] Error fetching managers:", error);
    return [];
  }
}

/**
 * Clears the manager cache for a specific clinic (or all clinics).
 * Useful after adding/removing managers in the CRM.
 */
export function clearManagerCache(clinicId?: string): void {
  if (clinicId) {
    managerCache.delete(clinicId);
  } else {
    managerCache.clear();
  }
  console.log(`[TwentyCRM] Cache cleared${clinicId ? ` for clinic ${clinicId}` : ""}`);
}

export async function findLeadByPhone(phoneNumber: string): Promise<{ id: string, relationshipManagerId?: string } | null> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return null;

  try {
    const fetchLead = async (phone: string) => {
      const filterParam = encodeURIComponent(`phone.primaryPhoneNumber[eq]:${phone}`);
      const url = `${apiUrl}/leadss?filter=${filterParam}&orderBy=createdAt[DescNullsLast]`;
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data?.data?.leadss ?? data?.leadss ?? data?.data ?? [];
    };

    // 1. FAST PATH: Try exact match without + prefix (since user stores 91... in CRM directly)
    let leads = await fetchLead(phoneNumber);
    if (leads && leads.length > 0) return { id: leads[0].id, relationshipManagerId: leads[0].relationshipManagerId };

    // 2. Try exact match with + prefix
    leads = await fetchLead(`+${phoneNumber}`);
    if (leads && leads.length > 0) return { id: leads[0].id, relationshipManagerId: leads[0].relationshipManagerId };

    // 3. Try stripping India country code (91)
    if (phoneNumber.startsWith('91')) {
      leads = await fetchLead(phoneNumber.substring(2));
      if (leads && leads.length > 0) return { id: leads[0].id, relationshipManagerId: leads[0].relationshipManagerId };
    }

    // 4. Try stripping US country code (1)
    if (phoneNumber.startsWith('1')) {
      leads = await fetchLead(phoneNumber.substring(1));
      if (leads && leads.length > 0) return { id: leads[0].id, relationshipManagerId: leads[0].relationshipManagerId };
    }

    return null;
  } catch (e) {
    console.error("[TwentyCRM] Error finding lead by phone:", e);
    return null;
  }
}

export async function createLeadNote(leadId: string, text: string): Promise<boolean> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return false;

  try {
    // 1. Fetch note targets for this lead to find an existing transcript
    let transcriptNote: any = null;
    const targetRes = await fetch(`${apiUrl}/noteTargets?filter=targetLeadsId[eq]:${leadId}&limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
    });

    if (targetRes.ok) {
      const targetData = await targetRes.json();
      const targets = targetData?.data?.noteTargets ?? targetData?.noteTargets ?? targetData?.data ?? [];

      const notePromises = targets.map((target: any) => {
        if (target.noteId) {
          return fetch(`${apiUrl}/notes/${target.noteId}`, {
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
          }).then(r => r.ok ? r.json() : null);
        }
        return Promise.resolve(null);
      });

      const noteResults = await Promise.all(notePromises);

      for (const noteData of noteResults) {
        if (!noteData) continue;
        const note = noteData?.data?.note ?? noteData?.note ?? noteData?.data ?? noteData;
        if (note && note.title === "📱 WhatsApp Chat Transcript") {
          transcriptNote = note;
          break;
        }
      }
    }

    const timestamp = new Date().toLocaleString();
    const formattedMessage = `[${timestamp}] 🟢 IN: ${text}`;

    if (transcriptNote) {
      // Append to existing thread
      let blocks: any[] = [];
      try {
        if (typeof transcriptNote.bodyV2?.blocknote === 'string') {
          blocks = JSON.parse(transcriptNote.bodyV2.blocknote);
        } else if (Array.isArray(transcriptNote.bodyV2?.blocknote)) {
          blocks = transcriptNote.bodyV2.blocknote;
        }
      } catch (e) {
        console.warn("[TwentyCRM] Could not parse existing blocknote, starting fresh array.");
      }

      blocks.push({ type: "paragraph", content: formattedMessage });

      await fetch(`${apiUrl}/notes/${transcriptNote.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyV2: {
            blocknote: JSON.stringify(blocks)
          }
        })
      });
      return true;
    } else {
      // Create new thread
      const response = await fetch(`${apiUrl}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "📱 WhatsApp Chat Transcript",
          bodyV2: {
            blocknote: JSON.stringify([{ type: "paragraph", content: formattedMessage }])
          }
        })
      });
      const noteData = await response.json();
      if (!response.ok) {
        console.error("[TwentyCRM] Note creation failed:", noteData);
        return false;
      }

      // Create NoteTarget relationship via GraphQL
      const noteId = noteData?.data?.createNote?.id ?? noteData?.data?.notes?.id ?? noteData?.data?.id ?? noteData?.id;
      if (noteId) {
        const graphqlUrl = apiUrl.replace('/rest', '/graphql');
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
            `
          })
        });
      }
      return true;
    }
  } catch (e) {
    console.error("[TwentyCRM] Error handling chat transcript:", e);
    return false;
  }
}

export async function createEscalationTask(leadId: string, managerId: string, message: string): Promise<boolean> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return false;

  try {
    const response = await fetch(`${apiUrl}/tasks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "🔥 WhatsApp Escalation Request",
        bodyV2: {
          blocknote: JSON.stringify([{ type: "paragraph", content: `Lead requested manager assistance.\n\nMessage: "${message}"` }])
        },
        assigneeId: managerId || null
      })
    });
    const taskData = await response.json();
    if (!response.ok) {
      console.error("[TwentyCRM] Task creation failed:", taskData);
      return false;
    }

    // Create TaskTarget relationship via GraphQL
    const taskId = taskData?.data?.createTask?.id ?? taskData?.data?.tasks?.id ?? taskData?.data?.id ?? taskData?.id;
    if (taskId) {
      const graphqlUrl = apiUrl.replace('/rest', '/graphql');
      await fetch(graphqlUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            mutation {
              createTaskTarget(data: {
                taskId: "${taskId}",
                targetLeadsId: "${leadId}"
              }) {
                id
              }
            }
          `
        })
      });
    }
    return true;
  } catch (e) {
    console.error("[TwentyCRM] Error creating escalation task:", e);
    return false;
  }
}

export async function updateLeadStage(leadId: string, newStage: string): Promise<boolean> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return false;

  try {
    const response = await fetch(`${apiUrl}/leadss/${leadId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        status: newStage
      })
    });

    if (!response.ok) {
      console.error("[TwentyCRM] Failed to update lead stage:", await response.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[TwentyCRM] Error updating lead stage:", e);
    return false;
  }
}

export async function updateLeadFields(leadId: string, fields: Record<string, any>): Promise<boolean> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return false;

  try {
    const response = await fetch(`${apiUrl}/leadss/${leadId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(fields)
    });

    if (!response.ok) {
      console.error("[TwentyCRM] Lead update failed:", await response.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[TwentyCRM] Error updating lead fields:", e);
    return false;
  }
}

export async function getClinicsList(): Promise<{ id: string, name: string }[]> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return [];

  try {
    const response = await fetch(`${apiUrl}/clinicss?orderBy=createdAt[AscNullsLast]`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    if (response.ok) {
      const data = await response.json();
      const clinics = data?.data?.clinicss ?? data?.clinicss ?? data?.data ?? [];
      return clinics.map((c: any) => ({ id: c.id, name: c.name }));
    }
    return [];
  } catch (e) {
    console.error("[TwentyCRM] Error fetching clinics list:", e);
    return [];
  }
}
export async function getLeadDetails(leadId: string): Promise<any> {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  if (!apiKey) return null;

  try {
    const url = `${apiUrl}/leadss/${leadId}`;
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
    });

    if (!response.ok) {
      console.error("[TwentyCRM] Failed to fetch lead details:", await response.text());
      return null;
    }

    const data = await response.json();
    return data?.data?.leadss ?? data?.leadss ?? data?.data ?? data;
  } catch (e) {
    console.error("[TwentyCRM] Error fetching lead details:", e);
    return null;
  }
}
