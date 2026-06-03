import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });

async function runPsql(query: string) { 
  try {
    await client.query(query); 
  } catch (err: any) {
    if (err.constraint) {
      const res = await client.query(`SELECT conname, pg_get_constraintdef(c.oid), conrelid::regclass as table_name FROM pg_constraint c WHERE conname = '${err.constraint}'`);
      if (res.rows.length > 0) {
        console.error(`\n🚨 CONSTRAINT VIOLATION 🚨`);
        console.error(`Table: ${res.rows[0].table_name}`);
        console.error(`Constraint: ${res.rows[0].conname}`);
        console.error(`Definition: ${res.rows[0].pg_get_constraintdef}`);
        console.error(`Query that failed: ${query}`);
      }
    } else {
      console.error(`\n🚨 SQL ERROR 🚨`);
      console.error(`Error: ${err.message}`);
      console.error(`Query that failed: ${query.substring(0, 1000)}...`);
    }
    throw err;
  }
}

function sqlString(value: any, columnType?: string) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return value.toString();

  if (columnType === 'json' || columnType === 'jsonb') {
    let parsed;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch(e) {
      parsed = value;
    }
    return `'${JSON.stringify(parsed).replace(/'/g, "''")}'`;
  }

  if (typeof value === 'object') {
    if (value instanceof Date) return `'${value.toISOString()}'`;
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function queryRows<T = any>(query: string): Promise<T[]> { 
  const result = await client.query(query); 
  return result.rows; 
}

async function main() {
  let name = "Clinic DEMO";
  let subdomain = "clinicdemo";
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === "--name") name = process.argv[i + 1];
    if (process.argv[i] === "--subdomain") subdomain = process.argv[i + 1];
  }
  
  console.log("🚀 Connecting to database...");
  await client.connect();
  console.log("✅ Connected.");

  console.log("🔍 Looking for a source workspace...");
  const rows = await queryRows(`SELECT id, "databaseSchema" FROM core.workspace ORDER BY "createdAt" ASC LIMIT 1;`);
  
  if (!rows || rows.length === 0) {
    throw new Error("No workspaces found in the database to clone from!");
  }
  
  const source = rows[0];
  console.log(`✅ Found source workspace: ${source.id} (Schema: ${source.databaseSchema})`);

  if (!source.databaseSchema) {
    throw new Error("Source workspace is missing a databaseSchema!");
  }

  const targetWorkspaceId = crypto.randomUUID();
  const targetSchema = `workspace_${crypto.randomBytes(12).toString("hex")}`;
  console.log(`🚀 Cloning schema ${source.databaseSchema} -> ${targetSchema}...`);

  const tables = await queryRows(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${source.databaseSchema}' AND table_type = 'BASE TABLE';`);
  await runPsql(`CREATE SCHEMA "${targetSchema}";`);
  for (const { table_name } of tables) {
    await runPsql(`CREATE TABLE "${targetSchema}"."${table_name}" (LIKE "${source.databaseSchema}"."${table_name}" INCLUDING ALL);`);
  }
  
  const seqs = await queryRows(`SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = '${source.databaseSchema}';`);
  for (const { sequence_name } of seqs) {
    await runPsql(`CREATE SEQUENCE "${targetSchema}"."${sequence_name}";`);
  }
  
  const enums = await queryRows(`SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '${source.databaseSchema}' GROUP BY t.typname;`);
  for (const e of enums) {
    await runPsql(`CREATE TYPE "${targetSchema}"."${e.typname}" AS ENUM (${e.labels});`);
  }

  console.log("✅ Schema cloned. Copying data...");

  for (const { table_name } of tables) {
    const columns = await queryRows<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = '${source.databaseSchema}'
        AND table_name = '${table_name}'
        AND is_generated = 'NEVER';
    `);

    if (columns.length > 0) {
      const colNames = columns.map((c) => `"${c.column_name}"`).join(', ');
      await runPsql(`INSERT INTO "${targetSchema}"."${table_name}" (${colNames}) SELECT ${colNames} FROM "${source.databaseSchema}"."${table_name}";`);
    }
  }

  console.log("✅ Data copied. Cloning core records...");

  const inviteHash = crypto.randomUUID();
  await runPsql(`INSERT INTO core.workspace (id, "displayName", logo, "inviteHash", "deletedAt", "createdAt", "updatedAt", "allowImpersonation", "isPublicInviteLinkEnabled", "activationStatus", "metadataVersion", "databaseSchema", subdomain, "isGoogleAuthEnabled", "isTwoFactorAuthenticationEnforced", "isPasswordAuthEnabled", "isMicrosoftAuthEnabled", "isCustomDomainEnabled", "defaultRoleId", "trashRetentionDays", "routerModel", "isGoogleAuthBypassEnabled", "isPasswordAuthBypassEnabled", "isMicrosoftAuthBypassEnabled", "workspaceCustomApplicationId", "editableProfileFields", "fastModel", "smartModel", "eventLogRetentionDays", "useRecommendedModels", "isInternalMessagesImportEnabled") SELECT '${targetWorkspaceId}', '${name}', logo, '${inviteHash}', NULL, NOW(), NOW(), "allowImpersonation", "isPublicInviteLinkEnabled", 'ACTIVE', "metadataVersion", '${targetSchema}', '${subdomain}', "isGoogleAuthEnabled", "isTwoFactorAuthenticationEnforced", "isPasswordAuthEnabled", "isMicrosoftAuthEnabled", 'false', "defaultRoleId", "trashRetentionDays", "routerModel", "isGoogleAuthBypassEnabled", "isPasswordAuthBypassEnabled", "isMicrosoftAuthBypassEnabled", "workspaceCustomApplicationId", "editableProfileFields", "fastModel", "smartModel", "eventLogRetentionDays", "useRecommendedModels", "isInternalMessagesImportEnabled" FROM core.workspace WHERE id = '${source.id}';`);

  const tablesToClone = [
    'core.application',
    'core."applicationVariable"',
    'core."dataSource"', 
    'core."objectMetadata"', 
    'core."fieldMetadata"', 
    'core.role', 
    'core."rolePermissionFlag"', 
    'core."roleTarget"', 
    'core.view', 
    'core."viewFieldGroup"',
    'core."viewField"', 
    'core."viewFilterGroup"',
    'core."viewFilter"', 
    'core."viewGroup"', 
    'core."viewSort"', 
    'core.webhook', 
    'core.agent'
  ];
  
  // 1. Fetch all rows
  const tableData: Record<string, any[]> = {};
  for (const table of tablesToClone) {
    const rows = await queryRows(`SELECT * FROM ${table} WHERE "workspaceId" = '${source.id}';`);
    tableData[table] = rows;
  }

  // 2. Generate new IDs and map them
  const idMap = new Map<string, string>();
  idMap.set(source.id, targetWorkspaceId);

  for (const table of tablesToClone) {
    for (const row of tableData[table]) {
      if (row.id) {
        idMap.set(row.id, crypto.randomUUID());
      }
    }
  }

  // 3. Replace all references to old IDs
  for (const table of tablesToClone) {
    for (const row of tableData[table]) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'string' && idMap.has(value)) {
          row[key] = idMap.get(value);
        }
      }
      
      // Specifically handle core.application unique constraints
      if (table === 'core.application') {
        if (row.universalIdentifier) row.universalIdentifier = crypto.randomUUID();
        if (row.packageJsonFileId) row.packageJsonFileId = null;
        if (row.yarnLockFileId) row.yarnLockFileId = null;
      }
    }
  }

  // 4. Insert rows back with valid columns
  for (const table of tablesToClone) {
    const rows = tableData[table];
    if (rows.length === 0) continue;

    const schemaName = table.split('.')[0];
    const tableNameClean = table.split('.')[1].replace(/"/g, "");

    const columns = await queryRows<{ column_name: string, data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${schemaName}'
        AND table_name = '${tableNameClean}'
        AND is_generated = 'NEVER';
    `);
    const validCols = new Map<string, string>();
    for (const c of columns) {
      validCols.set(c.column_name, c.data_type);
    }

    for (const row of rows) {
      const cols = [];
      const vals = [];
      for (const [key, value] of Object.entries(row)) {
        if (validCols.has(key)) {
          cols.push(`"${key}"`);
          vals.push(sqlString(value as any, validCols.get(key)!));
        }
      }
      await runPsql(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')});`);
    }
  }

  console.log("✅ Workspace clone complete!");
  console.log(`Workspace ID: ${targetWorkspaceId}`);
  console.log(`Subdomain: ${subdomain}`);
  console.log(`Schema: ${targetSchema}`);
  await client.end();
}

main().catch((err: any) => { 
  console.error("❌ Failed:", err.message); 
  process.exit(1); 
});
