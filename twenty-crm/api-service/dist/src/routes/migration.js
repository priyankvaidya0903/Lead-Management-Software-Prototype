import { Router } from "express";
const router = Router();
function getEnv() {
    const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
    const apiKey = process.env.TWENTY_API_KEY || "";
    return { apiUrl, apiKey };
}
function normalizePhone(value) {
    if (typeof value !== "string" && typeof value !== "number")
        return undefined;
    const digits = String(value).replace(/[^\d+]/g, "").trim();
    return digits || undefined;
}
function normalizeEmail(value) {
    if (typeof value !== "string")
        return undefined;
    const email = value.trim().toLowerCase();
    return email ? { primaryEmail: email } : undefined;
}
function normalizeSelect(value) {
    if (value === null || value === undefined)
        return undefined;
    const normalized = String(value).trim().toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
    return normalized || undefined;
}
function getValueByPath(input, path) {
    return path.split(".").reduce((acc, key) => {
        if (acc && typeof acc === "object" && key in acc) {
            return acc[key];
        }
        return undefined;
    }, input);
}
function setValue(output, key, value) {
    if (value === undefined || value === null || value === "")
        return;
    output[key] = value;
}
function applyStandardMapping(targetField, rawValue) {
    if (targetField === "email")
        return normalizeEmail(rawValue);
    if (targetField === "phone") {
        const phone = normalizePhone(rawValue);
        return phone ? { primaryPhoneNumber: phone } : undefined;
    }
    if (["source", "treatment", "stage", "status"].includes(targetField))
        return normalizeSelect(rawValue);
    if (typeof rawValue === "string")
        return rawValue.trim();
    return rawValue;
}
function buildFingerprint(record, uniqueBy) {
    return uniqueBy.map((field) => JSON.stringify(record[field] ?? null)).join("|");
}
function transformRecord(record, config) {
    const transformed = { ...(config.defaults || {}) };
    const errors = [];
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
async function findExistingRecord(apiUrl, apiKey, objectName, record, uniqueBy) {
    for (const field of uniqueBy) {
        const value = record[field];
        if (!value)
            continue;
        let filterField = field;
        let filterValue = value;
        if (field === "email" && typeof value === "object" && value && "primaryEmail" in value) {
            filterField = "email.primaryEmail";
            filterValue = value.primaryEmail;
        }
        if (field === "phone" && typeof value === "object" && value && "primaryPhoneNumber" in value) {
            filterField = "phone.primaryPhoneNumber";
            filterValue = value.primaryPhoneNumber;
        }
        const filterParam = encodeURIComponent(`${filterField}[eq]:${String(filterValue)}`);
        const response = await fetch(`${apiUrl}/${objectName}?filter=${filterParam}&limit=1`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
        });
        if (!response.ok)
            continue;
        const data = await response.json();
        const records = data?.data?.[objectName] ?? data?.[objectName] ?? data?.data ?? [];
        if (Array.isArray(records) && records.length > 0)
            return records[0].id;
    }
    return null;
}
async function upsertRecord(apiUrl, apiKey, objectName, record, uniqueBy) {
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
    return { action: existingId ? "updated" : "created", existingId, body };
}
router.post("/preview", async (req, res) => {
    const { records, config } = req.body;
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
router.post("/run", async (req, res) => {
    const { apiUrl, apiKey } = getEnv();
    const { records, config } = req.body;
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
    const output = [];
    for (const item of transformed) {
        if (item.errors.length > 0) {
            summary.invalid += 1;
            summary.skipped += 1;
            output.push({ fingerprint: item.fingerprint, status: "invalid", errors: item.errors, transformed: item.transformed });
            continue;
        }
        summary.valid += 1;
        if (dryRun) {
            output.push({ fingerprint: item.fingerprint, status: "dry-run", transformed: item.transformed });
            continue;
        }
        try {
            const result = await upsertRecord(apiUrl, apiKey, objectName, item.transformed, uniqueBy);
            if (result.action === "created")
                summary.created += 1;
            if (result.action === "updated")
                summary.updated += 1;
            output.push({ fingerprint: item.fingerprint, status: result.action, id: result.existingId, transformed: item.transformed });
        }
        catch (error) {
            summary.failed += 1;
            output.push({ fingerprint: item.fingerprint, status: "failed", error: error instanceof Error ? error.message : String(error), transformed: item.transformed });
        }
    }
    res.json({ objectName, dryRun, summary, output });
});
export default router;
