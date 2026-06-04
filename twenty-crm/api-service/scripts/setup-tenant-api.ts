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

async function getCustomFields(workspaceId: string, objectId: string) {
  return query(
    `SELECT id, name, label, type, description, icon,
            "defaultValue", options, settings, "isNullable", "relationTargetObjectMetadataId"
     FROM core."fieldMetadata"
     WHERE "workspaceId" = $1
       AND "objectMetadataId" = $2
       AND "isCustom" = true
       AND "isActive" = true
     ORDER BY type != 'RELATION', "createdAt"`,
    [workspaceId, objectId],
  );
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

async function introspectMutationInput(token: string, mutationName: string): Promise<string> {
  const data = await metadataGql(token, `{
    __type(name: "Mutation") {
      fields(includeDeprecated: true) {
        name
        args {
          name
          type {
            name
            kind
            ofType { name kind ofType { name kind } }
          }
        }
      }
    }
  }`);

  const field = data.__type.fields.find((f: any) => f.name === mutationName);
  if (!field) return "unknown";

  const inputArg = field.args.find((a: any) => a.name === "input");
  if (!inputArg) return "unknown";

  const typeName =
    inputArg.type.name ||
    inputArg.type.ofType?.name ||
    inputArg.type.ofType?.ofType?.name ||
    "unknown";

  if (typeName === "unknown") {
    console.log(`\n⚠️  [DEBUG] Introspection for ${mutationName} returned 'unknown'. Full field schema:`);
    console.log(JSON.stringify(field, null, 2));
  }

  return typeName;
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 4: Create objects/fields/relations via the API
// ═══════════════════════════════════════════════════════════════════

async function createObject(
  token: string,
  mutationName: string,
  obj: Row,
): Promise<Row> {
  // Try with nested "object" key first, fall back to flat input
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
  } catch (e1) {
    // Attempt 2: flat { nameSingular, ... } — some Twenty versions differ
    try {
      const data = await metadataGql(
        token,
        `mutation($input: CreateOneObjectInput!) {
          ${mutationName}(input: $input) { id nameSingular namePlural }
        }`,
        { input: objectInput },
      );
      return data[mutationName];
    } catch (e2) {
      // Attempt 3: discover the actual input type name via introspection
      const inputTypeName = await introspectMutationInput(token, mutationName);
      const data = await metadataGql(
        token,
        `mutation($input: ${inputTypeName}!) {
          ${mutationName}(input: $input) { id nameSingular namePlural }
        }`,
        { input: { object: objectInput } },
      );
      return data[mutationName];
    }
  }
}

async function createField(
  token: string,
  mutationName: string,
  targetObjectId: string,
  field: Row,
): Promise<Row> {
  const fieldInput: any = {
    objectMetadataId: targetObjectId,
    name: field.name,
    label: field.label,
    type: field.type,
    description: field.description || "",
    icon: field.icon || null,
    isNullable: field.isNullable ?? true,
  };

  if (field.type === 'RELATION' && field.relationTargetObjectMetadataId) {
    // We expect objectIdMap to have populated mapping, if not, it will be undefined and fail
    fieldInput.relationTargetObjectMetadataId = field.mappedTargetObjectId || field.relationTargetObjectMetadataId;
  }

  // Handle SELECT/MULTI_SELECT options
  if (
    (field.type === "SELECT" || field.type === "MULTI_SELECT") &&
    field.options
  ) {
    fieldInput.options = field.options;
  }

  // Handle defaultValue
  if (field.defaultValue != null) {
    fieldInput.defaultValue = field.defaultValue;
  }

  // Handle settings (e.g., currency settings)
  if (field.settings != null) {
    fieldInput.settings = field.settings;
  }

  try {
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneFieldMetadataInput!) {
        ${mutationName}(input: $input) { id name label type }
      }`,
      { input: { field: fieldInput } },
    );
    return data[mutationName];
  } catch (e1) {
    // Try flat input
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
//  Phase 5: Also look up standard (non-custom) objects in the
//           TARGET workspace so we can create cross-references
// ═══════════════════════════════════════════════════════════════════

async function getTargetObjectByName(
  token: string,
  nameSingular: string,
): Promise<string | null> {
  try {
    const data = await metadataGql(
      token,
      `{
        objects(paging: { first: 100 }) {
          edges {
            node {
              id
              nameSingular
            }
          }
        }
      }`,
    );
    const node = data.objects.edges.find(
      (e: any) => e.node.nameSingular === nameSingular,
    );
    return node ? node.node.id : null;
  } catch {
    return null;
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
      console.log(`  ${obj.labelSingular}: ${fields.length} custom field(s) — [${fields.map((f: Row) => f.name).join(", ")}]`);
    }

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

    // ── Discover mutation names ──
    console.log("\n═══ Phase 4: Introspecting Metadata API ═══");
    const mutations = await discoverMutations(token);

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

    // ── Create custom fields ──
    console.log("\n═══ Phase 6: Creating custom fields ═══");
    for (const obj of sourceObjects) {
      const targetObjectId = objectIdMap.get(obj.id);
      if (!targetObjectId) {
        console.log(`  Skipping fields for "${obj.labelSingular}" (object creation failed)`);
        continue;
      }

      const fields = sourceFieldsByObject[obj.id] || [];
      for (const field of fields) {
        if (field.type === 'RELATION') {
           field.mappedTargetObjectId = objectIdMap.get(field.relationTargetObjectMetadataId);
           if (!field.mappedTargetObjectId) {
             field.mappedTargetObjectId = (await getTargetObjectByName(token, "WorkspaceMember")) || field.relationTargetObjectMetadataId;
           }
        }
        try {
          process.stdout.write(`  ${obj.labelSingular}.${field.name}... `);
          await createField(token, mutations.fieldMutation, targetObjectId, field);
          console.log("✅");
        } catch (e: any) {
          console.log(`❌ ${e.message}`);
        }
      }
    }

    // ── Workflows ──
    console.log("\n═══ Phase 7: Cloning Internal Workflows ═══");
    try {
      const srcSchema = sourceWs.databaseSchema;
      const tgtSchema = targetWs.databaseSchema;
      
      const workflows = await query(`SELECT * FROM ${srcSchema}.workflow`);
      const workflowVersions = await query(`SELECT * FROM ${srcSchema}."workflowVersion"`);
      
      console.log(`  Found ${workflows.length} workflow(s) and ${workflowVersions.length} version(s).`);

      for (const wf of workflows) {
        process.stdout.write(`  Workflow "${wf.name}"... `);
        await run(`INSERT INTO ${tgtSchema}.workflow (id, "createdAt", "updatedAt", name, statuses, "workspaceMemberId") 
                   VALUES ($1, NOW(), NOW(), $2, $3, NULL) ON CONFLICT DO NOTHING`, 
                   [wf.id, wf.name, wf.statuses]);
        console.log("✅");
      }

      for (const wv of workflowVersions) {
        process.stdout.write(`  Workflow Version "${wv.name}"... `);
        
        let triggerStr = JSON.stringify(wv.trigger || {});
        let stepsStr = JSON.stringify(wv.steps || []);
        
        for (const [srcId, tgtId] of objectIdMap.entries()) {
          triggerStr = triggerStr.split(srcId).join(tgtId);
          stepsStr = stepsStr.split(srcId).join(tgtId);
        }

        await run(`INSERT INTO ${tgtSchema}."workflowVersion" (id, "createdAt", "updatedAt", name, trigger, steps, status, "workflowId") 
                   VALUES ($1, NOW(), NOW(), $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
                   [wv.id, wv.name, triggerStr, stepsStr, wv.status, wv.workflowId]);
        console.log("✅");
      }
    } catch (e: any) {
      console.log(`  ⚠️ Failed to clone workflows: ${e.message}`);
    }

    // ── Clone Webhooks ──
    console.log("\n═══ Phase 8: Cloning Webhooks ═══");
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
    console.log("\n═══ Phase 9: Creating Navigation Sidebar Items ═══");
    for (const obj of sourceObjects) {
      const targetObjectId = objectIdMap.get(obj.id);
      if (!targetObjectId) continue;
      
      try {
        process.stdout.write(`  Sidebar link for "${obj.labelPlural}"... `);
        // Only insert if it doesn't already exist for this object in the target workspace
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
    console.log("\n═══ Phase 10: Cleanup ═══");
    await cleanupTempApiKey(targetWs.id);
    console.log("✅ Temporary API key removed");

    console.log("\n" + "═".repeat(60));
    console.log("✅ SETUP COMPLETE");
    console.log("═".repeat(60));
    console.log(`Custom objects from "${sourceSubdomain}" have been created in "${targetSubdomain}".`);
    console.log("The workspace is ready to use!");
    console.log("\nRemember to flush Redis and restart the server:");
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
