import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });

async function runPsql(query: string) { 
  await client.query(query); 
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
    await runPsql(`INSERT INTO "${targetSchema}"."${table_name}" SELECT * FROM "${source.databaseSchema}"."${table_name}";`);
  }

  console.log("✅ Data copied. Cloning core records...");

  const inviteHash = crypto.randomUUID();
  await runPsql(`INSERT INTO core.workspace (id, "displayName", logo, "inviteHash", "deletedAt", "createdAt", "updatedAt", "allowImpersonation", "isPublicInviteLinkEnabled", "activationStatus", "metadataVersion", "databaseSchema", subdomain, "isGoogleAuthEnabled", "isTwoFactorAuthenticationEnforced", "isPasswordAuthEnabled", "isMicrosoftAuthEnabled", "isCustomDomainEnabled", "defaultRoleId", "trashRetentionDays", "routerModel", "isGoogleAuthBypassEnabled", "isPasswordAuthBypassEnabled", "isMicrosoftAuthBypassEnabled", "workspaceCustomApplicationId", "editableProfileFields", "fastModel", "smartModel", "eventLogRetentionDays", "useRecommendedModels", "isInternalMessagesImportEnabled") SELECT '${targetWorkspaceId}', '${name}', logo, '${inviteHash}', NULL, NOW(), NOW(), "allowImpersonation", "isPublicInviteLinkEnabled", 'ACTIVE', "metadataVersion", '${targetSchema}', '${subdomain}', "isGoogleAuthEnabled", "isTwoFactorAuthenticationEnforced", "isPasswordAuthEnabled", "isMicrosoftAuthEnabled", 'false', "defaultRoleId", "trashRetentionDays", "routerModel", "isGoogleAuthBypassEnabled", "isPasswordAuthBypassEnabled", "isMicrosoftAuthBypassEnabled", "workspaceCustomApplicationId", "editableProfileFields", "fastModel", "smartModel", "eventLogRetentionDays", "useRecommendedModels", "isInternalMessagesImportEnabled" FROM core.workspace WHERE id = '${source.id}';`);

  const tablesToClone = ['core."dataSource"', 'core."objectMetadata"', 'core."fieldMetadata"', 'core.role', 'core."rolePermissionFlag"', 'core."roleTarget"', 'core.view', 'core."viewField"', 'core."viewFieldGroup"', 'core."viewFilter"', 'core."viewFilterGroup"', 'core."viewGroup"', 'core."viewSort"', 'core.webhook', 'core.application', 'core."applicationVariable"', 'core.agent'];
  for (const table of tablesToClone) {
    await runPsql(`INSERT INTO ${table} SELECT * FROM ${table} WHERE "workspaceId" = '${source.id}';`);
    await runPsql(`UPDATE ${table} SET "workspaceId" = '${targetWorkspaceId}' WHERE "workspaceId" = '${source.id}';`);
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
