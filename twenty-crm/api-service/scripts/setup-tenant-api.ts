/**
 * setup-tenant-api.ts
 *
 * Creates custom objects (Leads, Clinics, Managers, etc.) in a target
 * workspace using Twenty CRM's GraphQL Metadata API.
 *
 * This is the SAFE approach: instead of cloning raw SQL rows (which breaks
 * internal application/index/relation references), we let Twenty CRM
 * create all the internal plumbing itself.
 *
 * Prerequisites:
 *   - The target workspace must be CLEAN (run clean-workspace.ts first)
 *   - The server must be running and healthy
 *   - ACCESS_TOKEN_SECRET env var must be set (same as your Twenty .env)
 *
 * Usage:
 *   npx tsx scripts/setup-tenant-api.ts \
 *     --source-subdomain aayna \
 *     --target-subdomain dermaclinic
 *
 * Environment:
 *   PG_DATABASE_URL          — Postgres connection string
 *   ACCESS_TOKEN_SECRET      — JWT signing secret from Twenty .env
 *   SERVER_URL               — Twenty server URL (default: http://server:3000)
 */
import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL =
  process.env.PG_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/default";
const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET;
const SERVER_URL = process.env.SERVER_URL || "http://server:3000";

const client = new Client({ connectionString: DATABASE_URL });

type Row = Record<string, any>;

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? null : process.argv[idx + 1] ?? null;
}

async function query<T = Row>(sql: string, values?: any[]): Promise<T[]> {
  return (await client.query(sql, values)).rows;
}

async function run(sql: string, values?: any[]) {
  return client.query(sql, values);
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 1: Read source workspace definitions from DB (read-only)
// ═══════════════════════════════════════════════════════════════════

async function getWorkspace(subdomain: string) {
  const rows = await query(
    `SELECT id, "databaseSchema", subdomain, "displayName", "workspaceCustomApplicationId"
     FROM core.workspace WHERE subdomain = $1 LIMIT 1`,
    [subdomain],
  );
  if (rows.length === 0) throw new Error(`Workspace not found: ${subdomain}`);
  return rows[0];
}

async function getCustomObjects(workspaceId: string) {
  return query(
    `SELECT id, "nameSingular", "namePlural", "labelSingular", "labelPlural",
            icon, description
     FROM core."objectMetadata"
     WHERE "workspaceId" = $1 AND "isCustom" = true AND "isActive" = true
     ORDER BY "createdAt"`,
    [workspaceId],
  );
}

/** Get non-RELATION custom fields only — relations are handled separately via SQL */
async function getCustomFields(workspaceId: string, objectId: string) {
  return query(
    `SELECT id, name, label, type, description, icon,
            "defaultValue", options, "isNullable"
     FROM core."fieldMetadata"
     WHERE "workspaceId" = $1
       AND "objectMetadataId" = $2
       AND "isCustom" = true
       AND "isActive" = true
       AND type != 'RELATION'
     ORDER BY "createdAt"`,
    [workspaceId, objectId],
  );
}

/** Get user-defined RELATION pairs from the source workspace.
 *  Excludes auto-created system relations (timelineActivities, attachments, etc.)
 *  Returns deduplicated pairs (only one direction per relation). */
async function getCustomRelationPairs(workspaceId: string, customObjectIds: string[]) {
  if (customObjectIds.length === 0) return [];

  const autoRelNames = [
    'timelineActivities', 'attachments', 'noteTargets', 'taskTargets',
    'favorites', 'activityTargets',
  ];

  // Get ALL custom RELATION fields that touch our custom objects
  const allRelFields = await query(
    `SELECT f.id, f.name, f.label, f.icon, f.type,
            f.settings, f."isNullable",
            f."objectMetadataId",
            f."relationTargetObjectMetadataId",
            f."relationTargetFieldMetadataId",
            o."nameSingular" AS "objectName",
            o."isCustom"     AS "objectIsCustom"
     FROM core."fieldMetadata" f
     JOIN core."objectMetadata" o ON o.id = f."objectMetadataId"
     WHERE f."workspaceId" = $1
       AND f.type = 'RELATION'
       AND f."isCustom" = true
       AND f."isActive" = true
     ORDER BY f."createdAt"`,
    [workspaceId],
  );

  // Build pairs: match each field with its inverse via relationTargetFieldMetadataId
  const pairs: Array<{ from: Row; to: Row }> = [];
  const seen = new Set<string>();
  const customObjSet = new Set(customObjectIds);

  for (const f of allRelFields) {
    if (seen.has(f.id)) continue;
    if (autoRelNames.includes(f.name)) continue;

    // At least one side must be a custom object we're cloning
    if (!customObjSet.has(f.objectMetadataId) && !customObjSet.has(f.relationTargetObjectMetadataId)) continue;

    const inverse = allRelFields.find((r) => r.id === f.relationTargetFieldMetadataId);
    if (inverse && !seen.has(inverse.id)) {
      seen.add(f.id);
      seen.add(inverse.id);
      pairs.push({ from: f, to: inverse });
    }
  }

  return pairs;
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 2: Generate or use API token
// ═══════════════════════════════════════════════════════════════════

async function getApiToken(workspaceId: string): Promise<string> {
  if (process.env.REAL_API_TOKEN) {
    return process.env.REAL_API_TOKEN;
  }

  // Fallback to forging one (not recommended)
  const jwt = (await import("jsonwebtoken")).default;
  if (!ACCESS_TOKEN_SECRET) {
    throw new Error("Provide REAL_API_TOKEN or ACCESS_TOKEN_SECRET env var.");
  }

  const keyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 3600_000);
  await run(
    `INSERT INTO core."apiKey" (id, name, "workspaceId", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, 'setup-tenant-temp', $2, $3, NOW(), NOW())`,
    [keyId, workspaceId, expiresAt],
  );

  return jwt.sign(
    { sub: workspaceId, type: "API_KEY", workspaceId },
    ACCESS_TOKEN_SECRET,
    { expiresIn: "1h", jwtid: keyId },
  );
}

async function cleanupTempApiKey(workspaceId: string) {
  if (process.env.REAL_API_TOKEN) return;
  await run(
    `DELETE FROM core."apiKey" WHERE name = 'setup-tenant-temp' AND "workspaceId" = $1`,
    [workspaceId],
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 3: GraphQL Metadata API helpers
// ═══════════════════════════════════════════════════════════════════

async function metadataGql(token: string, gql: string, variables?: any): Promise<any> {
  const res = await fetch(`${SERVER_URL}/metadata`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: gql, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Metadata API HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`GraphQL error: ${data.errors[0].message}`);
  }
  return data.data;
}

/** Introspect the metadata API to discover exact mutation names */
async function discoverMutations(token: string): Promise<Record<string, string>> {
  const data = await metadataGql(token, `{
    __schema {
      mutationType {
        fields { name }
      }
    }
  }`);

  const fields: string[] = data.__schema.mutationType.fields.map((f: any) => f.name);

  const objectMutation =
    fields.find((n) => /createOneObject/i.test(n)) || "createOneObjectMetadataItem";
  const fieldMutation =
    fields.find((n) => /createOneField/i.test(n)) || "createOneFieldMetadataItem";

  console.log(`  Discovered mutations: object=${objectMutation}, field=${fieldMutation}`);
  return { objectMutation, fieldMutation };
}

/** Introspect CreateFieldInput to discover which properties it accepts */
async function discoverFieldInputShape(token: string): Promise<Set<string>> {
  try {
    const data = await metadataGql(token, `{
      __type(name: "CreateFieldInput") {
        inputFields { name }
      }
    }`);
    const fieldNames = new Set<string>();
    for (const f of (data.__type?.inputFields || [])) {
      fieldNames.add(f.name);
    }
    console.log(`  CreateFieldInput accepts: [${[...fieldNames].join(", ")}]`);
    return fieldNames;
  } catch {
    // Fallback: assume a basic set
    return new Set(["objectMetadataId", "name", "label", "type", "description", "icon", "isNullable", "defaultValue", "options"]);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 4: Create objects/fields via the API
// ═══════════════════════════════════════════════════════════════════

async function createObject(
  token: string,
  mutationName: string,
  obj: Row,
): Promise<Row> {
  const objectInput = {
    nameSingular: obj.nameSingular,
    namePlural: obj.namePlural,
    labelSingular: obj.labelSingular,
    labelPlural: obj.labelPlural,
    icon: obj.icon || "IconBox",
    description: obj.description || "",
  };

  // Attempt 1: nested { object: { ... } }
  try {
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneObjectInput!) {
        ${mutationName}(input: $input) { id nameSingular namePlural }
      }`,
      { input: { object: objectInput } },
    );
    return data[mutationName];
  } catch {
    // Attempt 2: flat input
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneObjectInput!) {
        ${mutationName}(input: $input) { id nameSingular namePlural }
      }`,
      { input: objectInput },
    );
    return data[mutationName];
  }
}

async function createField(
  token: string,
  mutationName: string,
  targetObjectId: string,
  field: Row,
  allowedFields: Set<string>,
): Promise<Row> {
  // Build input dynamically based on what the API actually accepts
  const fieldInput: any = {};

  const propMap: Record<string, any> = {
    objectMetadataId: targetObjectId,
    name: field.name,
    label: field.label,
    type: field.type,
    description: field.description || "",
    icon: field.icon || null,
    isNullable: field.isNullable ?? true,
  };

  // Conditionally add SELECT/MULTI_SELECT options
  if ((field.type === "SELECT" || field.type === "MULTI_SELECT") && field.options) {
    propMap.options = field.options;
  }

  // Conditionally add defaultValue
  if (field.defaultValue != null) {
    propMap.defaultValue = field.defaultValue;
  }

  // Only include properties that the API schema actually accepts
  for (const [key, value] of Object.entries(propMap)) {
    if (allowedFields.has(key)) {
      fieldInput[key] = value;
    }
  }

  // Attempt 1: nested { field: { ... } }
  try {
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneFieldMetadataInput!) {
        ${mutationName}(input: $input) { id name label type }
      }`,
      { input: { field: fieldInput } },
    );
    return data[mutationName];
  } catch {
    // Attempt 2: flat input
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneFieldMetadataInput!) {
        ${mutationName}(input: $input) { id name label type }
      }`,
      { input: fieldInput },
    );
    return data[mutationName];
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 5: Clone user-defined relations via direct SQL
//  (The GraphQL API on this Twenty version has no relation mutation)
// ═══════════════════════════════════════════════════════════════════

async function cloneRelationsViaSql(
  sourceWs: Row,
  targetWs: Row,
  objectIdMap: Map<string, string>,
  relationPairs: Array<{ from: Row; to: Row }>,
) {
  // Build a full ID remap: source objectId → target objectId
  // Also include standard (non-custom) objects by querying the target
  const allSourceObjects = await query(
    `SELECT id, "nameSingular" FROM core."objectMetadata" WHERE "workspaceId" = $1`,
    [sourceWs.id],
  );
  const allTargetObjects = await query(
    `SELECT id, "nameSingular" FROM core."objectMetadata" WHERE "workspaceId" = $1`,
    [targetWs.id],
  );

  // Map source object IDs to target object IDs by nameSingular
  const fullObjectIdMap = new Map<string, string>();
  for (const [srcId, tgtId] of objectIdMap.entries()) {
    fullObjectIdMap.set(srcId, tgtId);
  }
  for (const srcObj of allSourceObjects) {
    if (fullObjectIdMap.has(srcObj.id)) continue;
    const tgtObj = allTargetObjects.find((t) => t.nameSingular === srcObj.nameSingular);
    if (tgtObj) {
      fullObjectIdMap.set(srcObj.id, tgtObj.id);
    }
  }

  // Get the columns of core.fieldMetadata so we can do a safe INSERT
  const fieldMetaCols = await query<{ column_name: string; is_generated: string }>(
    `SELECT column_name, is_generated FROM information_schema.columns
     WHERE table_schema = 'core' AND table_name = 'fieldMetadata'
     ORDER BY ordinal_position`,
  );
  // Exclude generated columns
  const colNames = fieldMetaCols
    .filter((c) => c.is_generated !== 'ALWAYS')
    .map((c) => c.column_name);

  // Columns that reference workspace members from source (may not exist in target)
  const nullableRefCols = [
    'createdByWorkspaceMemberId',
    'updatedByWorkspaceMemberId',
  ];

  // Discover the target workspace's applicationId (NOT NULL column — can't set to null)
  const [targetAppRow] = await query(
    `SELECT DISTINCT "applicationId" FROM core."fieldMetadata"
     WHERE "workspaceId" = $1 AND "applicationId" IS NOT NULL LIMIT 1`,
    [targetWs.id],
  );
  const targetApplicationId = targetAppRow?.applicationId || null;
  if (!targetApplicationId) {
    console.log("  ⚠️  Could not find target workspace applicationId — relations may fail");
  }

  for (const { from, to } of relationPairs) {
    const newFromId = crypto.randomUUID();
    const newToId = crypto.randomUUID();

    const mappedFromObjectId = fullObjectIdMap.get(from.objectMetadataId);
    const mappedFromTargetObjectId = fullObjectIdMap.get(from.relationTargetObjectMetadataId);
    const mappedToObjectId = fullObjectIdMap.get(to.objectMetadataId);
    const mappedToTargetObjectId = fullObjectIdMap.get(to.relationTargetObjectMetadataId);

    if (!mappedFromObjectId || !mappedFromTargetObjectId || !mappedToObjectId || !mappedToTargetObjectId) {
      console.log(`  Skipping ${from.objectName}.${from.name} (cannot map object IDs)`);
      continue;
    }

    process.stdout.write(`  ${from.objectName}.${from.name} \u2194 ${to.objectName}.${to.name}... `);

    try {
      // Check if a relation with this name already exists in the target
      const existing = await query(
        `SELECT id FROM core."fieldMetadata"
         WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND name = $3 AND type = 'RELATION'`,
        [targetWs.id, mappedFromObjectId, from.name],
      );
      if (existing.length > 0) {
        console.log("\u2705 (already exists)");
        continue;
      }

      // Read full source rows
      const [srcFrom] = await query(`SELECT * FROM core."fieldMetadata" WHERE id = $1`, [from.id]);
      const [srcTo] = await query(`SELECT * FROM core."fieldMetadata" WHERE id = $1`, [to.id]);

      if (!srcFrom || !srcTo) {
        console.log("\u274c source field not found");
        continue;
      }

      // Build remapped row \u2014 initially set cross-reference to NULL to avoid FK violation
      const buildRow = (src: Row, newId: string, objId: string, targetObjId: string) => {
        const row: any = { ...src };
        row.id = newId;
        row.workspaceId = targetWs.id;
        row.objectMetadataId = objId;
        row.relationTargetObjectMetadataId = targetObjId;
        row.relationTargetFieldMetadataId = null;  // Set to NULL first!
        row.createdAt = new Date();
        row.updatedAt = new Date();
        if ('universalIdentifier' in row) row.universalIdentifier = crypto.randomUUID();
        // Null out workspace member references that won't exist in target
        for (const col of nullableRefCols) {
          if (col in row) row[col] = null;
        }
        // Map applicationId to the target workspace's application (NOT NULL column)
        if (targetApplicationId && 'applicationId' in row) {
          row.applicationId = targetApplicationId;
        }
        return row;
      };

      const newFrom = buildRow(srcFrom, newFromId, mappedFromObjectId, mappedFromTargetObjectId);
      const newTo = buildRow(srcTo, newToId, mappedToObjectId, mappedToTargetObjectId);

      // PASS 1: Insert both sides with NULL cross-references
      for (const row of [newFrom, newTo]) {
        const cols = colNames.filter((c) => c in row);
        const vals = cols.map((c) => row[c]);
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const quotedCols = cols.map((c) => `"${c}"`).join(", ");

        await run(
          `INSERT INTO core."fieldMetadata" (${quotedCols}) VALUES (${placeholders})
           ON CONFLICT (id) DO NOTHING`,
          vals,
        );
      }

      // PASS 2: Now UPDATE both to set the cross-references
      await run(
        `UPDATE core."fieldMetadata" SET "relationTargetFieldMetadataId" = $1 WHERE id = $2`,
        [newToId, newFromId],
      );
      await run(
        `UPDATE core."fieldMetadata" SET "relationTargetFieldMetadataId" = $1 WHERE id = $2`,
        [newFromId, newToId],
      );

      // Add the join column to the workspace schema table if it's a MANY_TO_ONE
      const fromSettings = typeof srcFrom.settings === 'string' ? JSON.parse(srcFrom.settings) : (srcFrom.settings || {});
      const toSettings = typeof srcTo.settings === 'string' ? JSON.parse(srcTo.settings) : (srcTo.settings || {});

      const tgtSchema = targetWs.databaseSchema;

      // MANY_TO_ONE side has the joinColumnName
      for (const [settings, objId] of [[fromSettings, mappedFromObjectId], [toSettings, mappedToObjectId]] as [any, string][]) {
        if (settings.joinColumnName) {
          const objName = (await query(`SELECT "nameSingular" FROM core."objectMetadata" WHERE id = $1`, [objId]))[0]?.nameSingular;
          if (objName) {
            // Try with underscore prefix (custom objects) and without (standard objects)
            for (const prefix of ['_', '']) {
              try {
                await run(`ALTER TABLE "${tgtSchema}"."${prefix}${objName}" ADD COLUMN IF NOT EXISTS "${settings.joinColumnName}" uuid`);
                break; // success, stop trying
              } catch { /* try next prefix */ }
            }
          }
        }
      }

      console.log("✅");
    } catch (e: any) {
      console.log(`❌ ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 6: Clone workflows via dynamic SQL
// ═══════════════════════════════════════════════════════════════════

async function cloneWorkflows(
  sourceWs: Row,
  targetWs: Row,
  objectIdMap: Map<string, string>,
) {
  const srcSchema = sourceWs.databaseSchema;
  const tgtSchema = targetWs.databaseSchema;

  // Check if workflow table exists in source
  const tableCheck = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = 'workflow'`,
    [srcSchema],
  );
  if (tableCheck.length === 0) {
    console.log("  No workflow table found in source schema.");
    return;
  }

  // Columns to ALWAYS exclude from INSERT (generated/computed columns)
  const excludeCols = new Set(['searchVector']);

  /** Serialize a value for safe pg INSERT — stringify JS objects for JSONB columns */
  const pgSafe = (val: any): any => {
    if (val == null) return val;
    if (val instanceof Date) return val;
    if (typeof val === 'object') return JSON.stringify(val);
    return val;
  };

  // Discover actual columns dynamically, excluding generated ones
  const wfCols = (await query<{ column_name: string; is_generated: string }>(
    `SELECT column_name, is_generated FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'workflow'
     ORDER BY ordinal_position`,
    [srcSchema],
  )).filter((c) => c.is_generated !== 'ALWAYS' && !excludeCols.has(c.column_name))
    .map((c) => c.column_name);

  const wvCols = (await query<{ column_name: string; is_generated: string }>(
    `SELECT column_name, is_generated FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'workflowVersion'
     ORDER BY ordinal_position`,
    [srcSchema],
  )).filter((c) => c.is_generated !== 'ALWAYS' && !excludeCols.has(c.column_name))
    .map((c) => c.column_name);

  // Clone workflows
  const workflows = await query(`SELECT * FROM "${srcSchema}".workflow WHERE "deletedAt" IS NULL`);
  console.log(`  Found ${workflows.length} workflow(s).`);

  for (const wf of workflows) {
    process.stdout.write(`  Workflow "${wf.name || '(unnamed)'}"... `);
    try {
      // Use only columns that exist in both source and target
      const tgtWfCols = (await query<{ column_name: string; is_generated: string }>(
        `SELECT column_name, is_generated FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflow'`,
        [tgtSchema],
      )).filter((c) => c.is_generated !== 'ALWAYS' && !excludeCols.has(c.column_name))
        .map((c) => c.column_name);

      const commonCols = wfCols.filter((c) => tgtWfCols.includes(c));
      // Exclude workspace-member references that might not exist
      const safeCols = commonCols.filter((c) => wf[c] !== undefined);
      const vals = safeCols.map((c) => pgSafe(wf[c]));
      const placeholders = safeCols.map((_, i) => `$${i + 1}`).join(", ");
      const quotedCols = safeCols.map((c) => `"${c}"`).join(", ");

      await run(
        `INSERT INTO "${tgtSchema}".workflow (${quotedCols}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING`,
        vals,
      );
      console.log("✅");
    } catch (e: any) {
      console.log(`❌ ${e.message}`);
    }
  }

  // Clone workflow versions
  const workflowVersions = await query(`SELECT * FROM "${srcSchema}"."workflowVersion" WHERE "deletedAt" IS NULL`);
  console.log(`  Found ${workflowVersions.length} workflow version(s).`);

  for (const wv of workflowVersions) {
    process.stdout.write(`  Version "${wv.name || '(unnamed)'}"... `);
    try {
      const tgtWvCols = (await query<{ column_name: string; is_generated: string }>(
        `SELECT column_name, is_generated FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflowVersion'`,
        [tgtSchema],
      )).filter((c) => c.is_generated !== 'ALWAYS' && !excludeCols.has(c.column_name))
        .map((c) => c.column_name);

      const commonCols = wvCols.filter((c) => tgtWvCols.includes(c));
      const safeCols = commonCols.filter((c) => wv[c] !== undefined);

      // Remap object IDs inside trigger and steps JSONB, stringify all objects
      const vals = safeCols.map((c) => {
        let val = wv[c];
        if ((c === 'trigger' || c === 'steps') && val != null) {
          let str = JSON.stringify(val);
          for (const [srcId, tgtId] of objectIdMap.entries()) {
            str = str.split(srcId).join(tgtId);
          }
          return str;  // Already a string, ready for JSONB
        }
        return pgSafe(val);
      });

      const placeholders = safeCols.map((_, i) => `$${i + 1}`).join(", ");
      const quotedCols = safeCols.map((c) => `"${c}"`).join(", ");

      await run(
        `INSERT INTO "${tgtSchema}"."workflowVersion" (${quotedCols}) VALUES (${placeholders})
         ON CONFLICT (id) DO NOTHING`,
        vals,
      );
      console.log("✅");
    } catch (e: any) {
      console.log(`❌ ${e.message}`);
    }
  }

  // Clone workflowAutomatedTrigger if it exists
  const triggerTableCheck = await query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_name = 'workflowAutomatedTrigger'`,
    [srcSchema],
  );
  if (triggerTableCheck.length > 0) {
    const triggers = await query(`SELECT * FROM "${srcSchema}"."workflowAutomatedTrigger" WHERE "deletedAt" IS NULL`);
    if (triggers.length > 0) {
      console.log(`  Found ${triggers.length} automated trigger(s).`);
      const srcTrigCols = (await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflowAutomatedTrigger'`,
        [srcSchema],
      )).map((c) => c.column_name);
      const tgtTrigCols = (await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'workflowAutomatedTrigger'`,
        [tgtSchema],
      )).map((c) => c.column_name);

      for (const trig of triggers) {
        try {
          const commonCols = srcTrigCols.filter((c) => tgtTrigCols.includes(c) && trig[c] !== undefined);
          const vals = commonCols.map((c) => trig[c]);
          const placeholders = commonCols.map((_, i) => `$${i + 1}`).join(", ");
          const quotedCols = commonCols.map((c) => `"${c}"`).join(", ");
          await run(
            `INSERT INTO "${tgtSchema}"."workflowAutomatedTrigger" (${quotedCols}) VALUES (${placeholders})
             ON CONFLICT (id) DO NOTHING`,
            vals,
          );
        } catch { /* skip */ }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const sourceSubdomain = getArg("source-subdomain");
  const targetSubdomain = getArg("target-subdomain");

  if (!sourceSubdomain || !targetSubdomain) {
    console.error(
      "Usage: npx tsx scripts/setup-tenant-api.ts " +
      "--source-subdomain aayna --target-subdomain dermaclinic",
    );
    process.exit(1);
  }

  await client.connect();

  try {
    // ── Resolve workspaces ──
    const sourceWs = await getWorkspace(sourceSubdomain);
    const targetWs = await getWorkspace(targetSubdomain);

    console.log(`Source: ${sourceWs.displayName} (${sourceWs.id})`);
    console.log(`Target: ${targetWs.displayName} (${targetWs.id})`);

    // ── Read source definitions ──
    console.log("\n═══ Phase 1: Reading source custom objects ═══");
    const sourceObjects = await getCustomObjects(sourceWs.id);
    console.log(`Found ${sourceObjects.length} custom object(s)`);

    const sourceFieldsByObject: Record<string, Row[]> = {};
    for (const obj of sourceObjects) {
      const fields = await getCustomFields(sourceWs.id, obj.id);
      sourceFieldsByObject[obj.id] = fields;
      console.log(`  ${obj.labelSingular}: ${fields.length} non-relation field(s) — [${fields.map((f: Row) => f.name).join(", ")}]`);
    }

    // Read custom relation pairs
    const customRelPairs = await getCustomRelationPairs(
      sourceWs.id,
      sourceObjects.map((o: Row) => o.id),
    );
    console.log(`Found ${customRelPairs.length} user-defined relation pair(s)`);

    // ── Generate temp API key ──
    console.log("\n═══ Phase 2: Generating temporary API key ═══");
    const token = await getApiToken(targetWs.id);
    console.log("✅ Temporary API key generated");

    // ── Check server health ──
    console.log("\n═══ Phase 3: Checking server connectivity ═══");
    let serverReady = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const healthRes = await fetch(`${SERVER_URL}/healthz`, {
          signal: AbortSignal.timeout(5000),
        });
        if (healthRes.ok) {
          serverReady = true;
          console.log("✅ Server is healthy");
          break;
        }
      } catch {
        console.log(`  Attempt ${attempt}/5 — server not ready, waiting 3s...`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!serverReady) {
      throw new Error(`Server at ${SERVER_URL} is not reachable. Is it running?`);
    }

    // ── Discover mutation names + field input shape ──
    console.log("\n═══ Phase 4: Introspecting Metadata API ═══");
    const mutations = await discoverMutations(token);
    const allowedFieldProps = await discoverFieldInputShape(token);

    // ── Create custom objects ──
    console.log("\n═══ Phase 5: Creating custom objects ═══");
    const objectIdMap = new Map<string, string>(); // sourceId → targetId

    for (const obj of sourceObjects) {
      try {
        process.stdout.write(`  Creating "${obj.labelSingular}"... `);
        const newObj = await createObject(token, mutations.objectMutation, obj);
        objectIdMap.set(obj.id, newObj.id);
        console.log(`✅ (${newObj.id})`);
      } catch (e: any) {
        console.log(`❌ ${e.message}`);
      }
    }

    // ── Create custom fields (non-relation only) ──
    console.log("\n═══ Phase 6: Creating custom fields ═══");
    for (const obj of sourceObjects) {
      const targetObjectId = objectIdMap.get(obj.id);
      if (!targetObjectId) {
        console.log(`  Skipping fields for "${obj.labelSingular}" (object creation failed)`);
        continue;
      }

      const fields = sourceFieldsByObject[obj.id] || [];
      for (const field of fields) {
        try {
          process.stdout.write(`  ${obj.labelSingular}.${field.name}... `);
          await createField(token, mutations.fieldMutation, targetObjectId, field, allowedFieldProps);
          console.log("✅");
        } catch (e: any) {
          console.log(`❌ ${e.message}`);
        }
      }
    }

    // ── Clone user-defined relations via SQL ──
    console.log("\n═══ Phase 7: Cloning user-defined relations via SQL ═══");
    if (customRelPairs.length > 0) {
      await cloneRelationsViaSql(sourceWs, targetWs, objectIdMap, customRelPairs);
    } else {
      console.log("  No user-defined relations to clone.");
    }

    // ── Workflows ──
    console.log("\n═══ Phase 8: Cloning Internal Workflows ═══");
    try {
      await cloneWorkflows(sourceWs, targetWs, objectIdMap);
    } catch (e: any) {
      console.log(`  ⚠️ Failed to clone workflows: ${e.message}`);
    }

    // ── Clone Webhooks ──
    console.log("\n═══ Phase 9: Cloning Webhooks ═══");
    const sourceWebhooks = await query(`SELECT * FROM core.webhook WHERE "workspaceId" = $1`, [sourceWs.id]);
    for (const hw of sourceWebhooks) {
      try {
        process.stdout.write(`  Webhook to ${hw.targetUrl}... `);
        const newId = crypto.randomUUID();
        await run(
          `INSERT INTO core.webhook (id, "targetUrl", operations, description, secret, "workspaceId", "createdAt", "updatedAt", "universalIdentifier", "applicationId")
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7, $8)`,
          [newId, hw.targetUrl, hw.operations, hw.description, hw.secret, targetWs.id, crypto.randomUUID(), hw.applicationId]
        );
        console.log("✅");
      } catch (e: any) {
        console.log(`❌ ${e.message}`);
      }
    }

    // ── Setup Visibility (Navigation Menu Items) ──
    console.log("\n═══ Phase 10: Creating Navigation Sidebar Items ═══");
    for (const obj of sourceObjects) {
      const targetObjectId = objectIdMap.get(obj.id);
      if (!targetObjectId) continue;
      
      try {
        process.stdout.write(`  Sidebar link for "${obj.labelPlural}"... `);
        const existing = await query(`SELECT id FROM core."navigationMenuItem" WHERE "workspaceId" = $1 AND "targetObjectMetadataId" = $2`, [targetWs.id, targetObjectId]);
        
        if (existing.length === 0) {
          const newId = crypto.randomUUID();
          await run(
            `INSERT INTO core."navigationMenuItem" (id, "workspaceId", "targetObjectMetadataId", name, type, "createdAt", "updatedAt", "universalIdentifier")
             VALUES ($1, $2, $3, $4, 'object', NOW(), NOW(), $5)`,
            [newId, targetWs.id, targetObjectId, obj.namePlural, crypto.randomUUID()]
          );
          console.log("✅");
        } else {
          console.log("✅ (already exists)");
        }
      } catch (e: any) {
        console.log(`❌ ${e.message}`);
      }
    }

    // ── Cleanup ──
    console.log("\n═══ Phase 11: Cleanup & Cache Refresh ═══");
    await cleanupTempApiKey(targetWs.id);
    console.log("✅ Temporary API key removed");

    // Bump metadataVersion so Twenty's UI picks up the new fields/relations
    await run(
      `UPDATE core.workspace SET "metadataVersion" = "metadataVersion" + 1 WHERE id = $1`,
      [targetWs.id],
    );
    console.log("✅ Metadata version bumped (forces UI cache refresh)");

    // Also try to flush Redis if accessible (best-effort)
    try {
      const redisRes = await fetch(`${SERVER_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (redisRes.ok) {
        console.log("✅ Server is healthy — cache will refresh on next request");
      }
    } catch { /* Redis flush is manual — that's OK */ }

    console.log("\n" + "═".repeat(60));
    console.log("✅ SETUP COMPLETE");
    console.log("═".repeat(60));
    console.log(`Custom objects from "${sourceSubdomain}" have been created in "${targetSubdomain}".`);
    console.log("The workspace is ready to use!");
    console.log("\nJust flush Redis and restart the server:");
    console.log("  sudo docker-compose -f docker-compose.prod.yml exec redis redis-cli flushall");
    console.log("  sudo docker-compose -f docker-compose.prod.yml restart server");
  } finally {
    await client.end();
  }
}

main().catch(async (e: Error) => {
  console.error("\n❌ Failed:", e.message);
  console.error(e.stack);
  await client.end().catch(() => {});
  process.exit(1);
});
