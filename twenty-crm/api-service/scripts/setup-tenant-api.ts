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
            "defaultValue", options, settings, "isNullable"
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

async function getCustomRelations(workspaceId: string, objectIds: string[]) {
  if (objectIds.length === 0) return [];
  // Build a parameterized IN clause
  const placeholders = objectIds.map((_, i) => `$${i + 2}`).join(", ");
  try {
    return await query(
      `SELECT rm.id, rm."relationType",
              rm."fromObjectMetadataId", rm."toObjectMetadataId",
              ff.name  AS "fromFieldName",  ff.label  AS "fromFieldLabel",  ff.icon AS "fromIcon",
              tf.name  AS "toFieldName",    tf.label  AS "toFieldLabel",    tf.icon AS "toIcon",
              fo."nameSingular" AS "fromObjectName",
              tobj."nameSingular" AS "toObjectName",
              tobj."isCustom" AS "toObjectIsCustom",
              fo."isCustom" AS "fromObjectIsCustom"
       FROM core."relation" rm
       JOIN core."fieldMetadata" ff   ON ff.id   = rm."fromFieldMetadataId"
       JOIN core."fieldMetadata" tf   ON tf.id   = rm."toFieldMetadataId"
       JOIN core."objectMetadata" fo  ON fo.id   = rm."fromObjectMetadataId"
       JOIN core."objectMetadata" tobj ON tobj.id = rm."toObjectMetadataId"
       WHERE rm."workspaceId" = $1
         AND (rm."fromObjectMetadataId" IN (${placeholders})
              OR rm."toObjectMetadataId" IN (${placeholders}))
       ORDER BY rm."createdAt"`,
      [workspaceId, ...objectIds],
    );
  } catch (e: any) {
    if (e.message.includes('relation "core.relation" does not exist')) {
      return [];
    }
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Phase 2: Generate a temporary API key for the target workspace
// ═══════════════════════════════════════════════════════════════════

async function generateTempApiKey(workspaceId: string): Promise<string> {
  // Dynamic import so the script only needs jsonwebtoken when actually used
  const jwt = (await import("jsonwebtoken")).default;

  if (!ACCESS_TOKEN_SECRET) {
    throw new Error(
      "ACCESS_TOKEN_SECRET env var is required.\n" +
      "Get it from your Twenty .env file: grep ACCESS_TOKEN_SECRET .env",
    );
  }

  const keyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 3600_000); // 1 hour

  await run(
    `INSERT INTO core."apiKey" (id, name, "workspaceId", "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, 'setup-tenant-temp', $2, $3, NOW(), NOW())`,
    [keyId, workspaceId, expiresAt],
  );

  const token = jwt.sign(
    { sub: workspaceId, type: "API_KEY", workspaceId },
    ACCESS_TOKEN_SECRET,
    { expiresIn: "1h", jwtid: keyId },
  );

  return token;
}

async function cleanupTempApiKey(workspaceId: string) {
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

  // Find the object creation mutation
  const objectMutation =
    fields.find((n) => /createOneObject/i.test(n)) || "createOneObjectMetadataItem";
  const fieldMutation =
    fields.find((n) => /createOneField/i.test(n)) || "createOneFieldMetadataItem";
  const relationMutation =
    fields.find((n) => /createOneRelation/i.test(n)) || "createOneRelationMetadataItem";

  console.log(`  Discovered mutations: object=${objectMutation}, field=${fieldMutation}, relation=${relationMutation}`);
  return { objectMutation, fieldMutation, relationMutation };
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

async function createRelation(
  token: string,
  mutationName: string,
  fromObjectId: string,
  toObjectId: string,
  rel: Row,
): Promise<Row | null> {
  const relationInput = {
    relationType: rel.relationType,
    fromObjectMetadataId: fromObjectId,
    toObjectMetadataId: toObjectId,
    fromName: rel.fromFieldName,
    fromLabel: rel.fromFieldLabel,
    fromIcon: rel.fromIcon || "IconBox",
    toName: rel.toFieldName,
    toLabel: rel.toFieldLabel,
    toIcon: rel.toIcon || "IconBox",
  };

  try {
    const data = await metadataGql(
      token,
      `mutation($input: CreateOneRelationInput!) {
        ${mutationName}(input: $input) { id }
      }`,
      { input: { relation: relationInput } },
    );
    return data[mutationName];
  } catch (e1) {
    // Try flat input
    try {
      const data = await metadataGql(
        token,
        `mutation($input: CreateOneRelationInput!) {
          ${mutationName}(input: $input) { id }
        }`,
        { input: relationInput },
      );
      return data[mutationName];
    } catch (e2) {
      console.error(`    ⚠️  Relation creation failed: ${(e2 as Error).message}`);
      return null;
    }
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

    const sourceRelations = await getCustomRelations(
      sourceWs.id,
      sourceObjects.map((o: Row) => o.id),
    );
    console.log(`Found ${sourceRelations.length} relation(s)`);

    // ── Generate temp API key ──
    console.log("\n═══ Phase 2: Generating temporary API key ═══");
    const token = await generateTempApiKey(targetWs.id);
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
        try {
          process.stdout.write(`  ${obj.labelSingular}.${field.name}... `);
          await createField(token, mutations.fieldMutation, targetObjectId, field);
          console.log("✅");
        } catch (e: any) {
          console.log(`❌ ${e.message}`);
        }
      }
    }

    // ── Create relations ──
    console.log("\n═══ Phase 7: Creating relations ═══");
    for (const rel of sourceRelations) {
      let fromId = objectIdMap.get(rel.fromObjectMetadataId);
      let toId = objectIdMap.get(rel.toObjectMetadataId);

      // If one side is a standard object (not custom), look it up in the target
      if (!fromId && !rel.fromObjectIsCustom) {
        fromId = (await getTargetObjectByName(token, rel.fromObjectName)) || undefined;
      }
      if (!toId && !rel.toObjectIsCustom) {
        toId = (await getTargetObjectByName(token, rel.toObjectName)) || undefined;
      }

      if (!fromId || !toId) {
        console.log(`  Skipping relation ${rel.fromObjectName}.${rel.fromFieldName} → ${rel.toObjectName} (missing object mapping)`);
        continue;
      }

      try {
        process.stdout.write(`  ${rel.fromObjectName}.${rel.fromFieldName} → ${rel.toObjectName}... `);
        await createRelation(token, mutations.relationMutation, fromId, toId, rel);
        console.log("✅");
      } catch (e: any) {
        console.log(`❌ ${e.message}`);
      }
    }

    // ── Cleanup ──
    console.log("\n═══ Phase 8: Cleanup ═══");
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
