import { Router, Request, Response } from "express";
import { createLeadNote } from "../lib/twentyCrmClient";

type LegacyRecord = Record<string, unknown>;
type JsonMap = Record<string, string>;

type TransformConfig = {
  targetObject?: string;
  uniqueBy?: string[];
  fieldMap?: JsonMap;
  defaults?: Record<string, unknown>;
  valueMaps?: Record<string, Record<string, unknown>>;
  requiredFields?: string[];
  batchSize?: number;
  dryRun?: boolean;
};

type TransformResult = {
  source: LegacyRecord;
  transformed: Record<string, unknown>;
  fingerprint: string;
  errors: string[];
};

const router = Router();

function getEnv() {
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY || "";
  return { apiUrl, apiKey };
}

function normalizePhone(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const digits = String(value).replace(/[^\d+]/g, "").trim();
  return digits || undefined;
}

function normalizeEmail(value: unknown): { primaryEmail: string } | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email ? { primaryEmail: email } : undefined;
}

function normalizeSelect(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = String(value).trim().toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
  return normalized || undefined;
}

function getValueByPath(input: LegacyRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, input);
}

function setValue(output: Record<string, unknown>, key: string, value: unknown) {
  if (value === undefined || value === null || value === "") return;
  output[key] = value;
}

function applyStandardMapping(targetField: string, rawValue: unknown): unknown {
  if (targetField === "email") return normalizeEmail(rawValue);
  if (targetField === "phone") {
    // If the raw value is already a formatted object, just pass it through
    if (typeof rawValue === "object" && rawValue !== null) return rawValue;
    
    const phone = normalizePhone(rawValue);
    // Twenty CRM requires the calling code for valid phone numbers
    return phone ? { 
      primaryPhoneNumber: phone,
      primaryPhoneCallingCode: "+91",
      primaryPhoneCountryCode: "IN"
    } : undefined;
  }
  if (["source", "treatment", "status"].includes(targetField)) return normalizeSelect(rawValue);
  if (typeof rawValue === "string") return rawValue.trim();
  return rawValue;
}

function buildFingerprint(record: Record<string, unknown>, uniqueBy: string[]): string {
  return uniqueBy.map((field) => JSON.stringify(record[field] ?? null)).join("|");
}

function transformRecord(record: LegacyRecord, config: TransformConfig): TransformResult {
  const transformed: Record<string, unknown> = { ...(config.defaults || {}) };
  const errors: string[] = [];
  const fieldMap = config.fieldMap || {};

  for (const [sourceField, targetField] of Object.entries(fieldMap)) {
    const rawValue = getValueByPath(record, sourceField);
    const mappedValue = config.valueMaps?.[targetField]?.[String(rawValue)] ?? applyStandardMapping(targetField, rawValue);
    setValue(transformed, targetField, mappedValue);
  }

  for (const field of config.requiredFields || []) {
    const value = transformed[field];
    if (value === undefined || value === null || value === "") {
      errors.push(`Missing required field: ${field}`);
    }
  }

  const uniqueBy = config.uniqueBy?.length ? config.uniqueBy : ["email", "phone", "name"];
  const fingerprint = buildFingerprint(transformed, uniqueBy);
  return { source: record, transformed, fingerprint, errors };
}

async function findExistingRecord(
  apiUrl: string,
  apiKey: string,
  objectName: string,
  record: Record<string, unknown>,
  uniqueBy: string[]
): Promise<string | null> {
  for (const field of uniqueBy) {
    const value = record[field];
    if (!value) continue;

    let filterField = field;
    let filterValue = value;

    if (field === "email" && typeof value === "object" && value && "primaryEmail" in value) {
      filterField = "email.primaryEmail";
      filterValue = (value as { primaryEmail: string }).primaryEmail;
    }

    if (field === "phone" && typeof value === "object" && value && "primaryPhoneNumber" in value) {
      filterField = "phone.primaryPhoneNumber";
      filterValue = (value as { primaryPhoneNumber: string }).primaryPhoneNumber;
    }

    const filterParam = encodeURIComponent(`${filterField}[eq]:${String(filterValue)}`);
    const response = await fetch(`${apiUrl}/${objectName}?filter=${filterParam}&limit=1`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) continue;
    const data = await response.json();
    const records = data?.data?.[objectName] ?? data?.[objectName] ?? data?.data ?? [];
    if (Array.isArray(records) && records.length > 0) return records[0].id;
  }

  return null;
}

async function upsertRecord(
  apiUrl: string,
  apiKey: string,
  objectName: string,
  record: Record<string, unknown>,
  uniqueBy: string[]
) {
  const existingId = await findExistingRecord(apiUrl, apiKey, objectName, record, uniqueBy);
  const url = existingId ? `${apiUrl}/${objectName}/${existingId}` : `${apiUrl}/${objectName}`;
  const method = existingId ? "PATCH" : "POST";

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(record),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status} ${body}`);
  }

  let parsedBody;
  try { parsedBody = JSON.parse(body); } catch(e) {}
  const returnedId = parsedBody?.data?.id || parsedBody?.data?.createLeadss?.[0]?.id || parsedBody?.data?.updateLeadss?.[0]?.id || parsedBody?.id || existingId;

  return { action: existingId ? "updated" : "created", existingId, body, returnedId };
}

router.post("/preview", async (req: Request, res: Response) => {
  const { records, config } = req.body as { records?: LegacyRecord[]; config?: TransformConfig };

  if (!Array.isArray(records) || !config) {
    res.status(400).json({ error: "records[] and config are required" });
    return;
  }

  const results = records.map((record) => transformRecord(record, config));
  res.json({
    targetObject: config.targetObject || "leadss",
    total: results.length,
    valid: results.filter((r) => r.errors.length === 0).length,
    invalid: results.filter((r) => r.errors.length > 0).length,
    results,
  });
});

router.post("/run", async (req: Request, res: Response) => {
  const { apiUrl, apiKey } = getEnv();
  const { records, config } = req.body as { records?: LegacyRecord[]; config?: TransformConfig };

  if (!apiKey) {
    res.status(400).json({ error: "TWENTY_API_KEY is required" });
    return;
  }

  if (!Array.isArray(records) || !config) {
    res.status(400).json({ error: "records[] and config are required" });
    return;
  }

  const objectName = config.targetObject || "leadss";
  const uniqueBy = config.uniqueBy?.length ? config.uniqueBy : ["email", "phone"];
  const dryRun = Boolean(config.dryRun);
  
  console.log(`[Migration API] Received request to /run with ${records.length} records. (dryRun: ${dryRun})`);
  
  const transformed = records.map((record) => transformRecord(record, config));

  const summary = {
    total: transformed.length,
    valid: 0,
    invalid: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  const output = [] as Array<Record<string, unknown>>;

  for (const item of transformed) {
    if (item.errors.length > 0) {
      summary.invalid += 1;
      summary.skipped += 1;
      output.push({ fingerprint: item.fingerprint, status: "invalid", errors: item.errors, transformed: item.transformed });
      continue;
    }

    summary.valid += 1;

    if (dryRun) {
      console.log(`[Migration API] Dry-run: skipping upsert for ${item.fingerprint}`);
      output.push({ fingerprint: item.fingerprint, status: "dry-run", transformed: item.transformed });
      continue;
    }

    try {
      console.log(`[Migration API] Upserting record for ${item.fingerprint}...`);
      
      const recordToUpsert = { ...item.transformed } as any;
      const lastComment = recordToUpsert.lastComment;
      const lastCommentDate = recordToUpsert.lastCommentDate;
      
      delete recordToUpsert.lastComment;
      delete recordToUpsert.lastCommentDate;
      
      const result = await upsertRecord(apiUrl, apiKey, objectName, recordToUpsert, uniqueBy);
      if (result.action === "created") summary.created += 1;
      else summary.updated += 1;
      
      if (lastComment && result.returnedId && objectName === "leadss") {
        console.log(`[Migration API] Adding historical comment to timeline for lead ${result.returnedId}...`);
        const noteText = lastCommentDate ? `**Historical Comment** (*${lastCommentDate}*):\n${lastComment}` : `**Historical Comment**:\n${lastComment}`;
        await createLeadNote(result.returnedId, noteText);
      }
      
      console.log(`[Migration API] ✅ Success: ${result.action} record (ID: ${result.returnedId || 'N/A'})`);
      output.push({ fingerprint: item.fingerprint, status: result.action, id: result.returnedId, transformed: item.transformed });
    } catch (error) {
      summary.failed += 1;
      console.error(`[Migration API] ❌ Error upserting record:`, error);
      output.push({ fingerprint: item.fingerprint, status: "failed", error: error instanceof Error ? error.message : String(error), transformed: item.transformed });
    }
  }

  console.log(`[Migration API] Completed processing ${transformed.length} records. Summary:`, summary);

  res.json({ objectName, dryRun, summary, output });
});

export default router;
