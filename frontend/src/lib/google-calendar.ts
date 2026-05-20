import { google } from "googleapis";

export interface CalendarEventInput {
  title: string;
  description?: string;
  dueAt?: string | null; // ISO 8601 datetime string, nullable
  taskId?: string;
}

export interface CalendarEventResult {
  eventId: string;
  htmlLink: string;
}

/**
 * Load Google service account credentials from env.
 * Supports either:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — full JSON string (recommended for env-only setups)
 *   GOOGLE_SERVICE_ACCOUNT_KEY_PATH — path to the JSON file
 */
function loadCredentials(): object {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(
        "GOOGLE_SERVICE_ACCOUNT_KEY is set but is not valid JSON. Make sure to JSON-stringify the service account file contents."
      );
    }
  }

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath) {
    // Dynamic require so Next.js doesn't try to bundle the file at build time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs");
    return JSON.parse(fs.readFileSync(keyPath, "utf8"));
  }

  throw new Error(
    "Google Calendar credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY (JSON string) or GOOGLE_SERVICE_ACCOUNT_KEY_PATH in your .env.local"
  );
}

/**
 * Creates a Google Calendar event from a Twenty CRM task.
 *
 * - If dueAt is provided: creates a 1-hour event at that time.
 * - If dueAt is missing:  creates an all-day event for today.
 */
export async function createCalendarEventFromTask(
  input: CalendarEventInput
): Promise<CalendarEventResult> {
  const credentials = loadCredentials();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "primary";

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  let startObj: { dateTime?: string; date?: string; timeZone?: string };
  let endObj: { dateTime?: string; date?: string; timeZone?: string };

  if (input.dueAt) {
    const startTime = new Date(input.dueAt);
    const endTime = new Date(startTime.getTime() + 60 * 60 * 1000); // +1 hour
    startObj = { dateTime: startTime.toISOString(), timeZone: "UTC" };
    endObj = { dateTime: endTime.toISOString(), timeZone: "UTC" };
  } else {
    // All-day event for today
    const today = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split("T")[0];
    startObj = { date: today };
    endObj = { date: tomorrow };
  }

  const descriptionParts: string[] = [];
  if (input.description) descriptionParts.push(input.description);
  if (input.taskId) descriptionParts.push(`Twenty CRM Task ID: ${input.taskId}`);

  const response = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: input.title,
      description: descriptionParts.join("\n\n") || undefined,
      start: startObj,
      end: endObj,
      source: {
        title: "Twenty CRM",
        url: `http://localhost:3000`,
      },
    },
  });

  const event = response.data;
  console.log(`[calendar] Event created: ${event.id} — ${event.summary}`);

  return {
    eventId: event.id!,
    htmlLink: event.htmlLink!,
  };
}
