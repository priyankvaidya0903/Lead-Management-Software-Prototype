/**
 * Twenty CRM Client — Manager Query
 *
 * Fetches Relationship Managers from Twenty CRM for a given clinic.
 * Results are cached in-memory for CACHE_TTL_MS to avoid hammering the CRM API
 * on every lead submission.
 *
 * Configuration (via .env.local):
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
      "Set it in .env.local: Settings → APIs & Webhooks → API Keys"
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
    const managers: Manager[] =
      data?.data?.[objectName] ?? // nested format
      data?.[objectName] ??        // flat format
      data?.data ??                // generic fallback
      [];

    console.log(
      `[TwentyCRM] Found ${managers.length} manager(s) for clinic ${clinicId}`
    );

    // Store in cache
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
