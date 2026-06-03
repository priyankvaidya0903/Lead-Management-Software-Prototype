import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;

const DATABASE_URL =
  process.env.PG_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/default";

const SOURCE_WORKSPACE_ID = process.env.SOURCE_WORKSPACE_ID;
const SOURCE_WORKSPACE_SCHEMA = process.env.SOURCE_WORKSPACE_SCHEMA;
const SOURCE_WORKSPACE_SUBDOMAIN = process.env.SOURCE_WORKSPACE_SUBDOMAIN;

type QueryResultRow = Record<string, unknown>;

type WorkspaceRow = {
  id: string;
  displayName: string;
  databaseSchema: string;
  subdomain: string | null;
  customDomain: string | null;
  defaultRoleId: string | null;
};

const client = new Client({ connectionString: DATABASE_URL });
console.log("Script initialized");

function usage() {
  console.error(
    "Usage: npm run setup-tenant -- --name \"Clinic A\" --subdomain clinica [--custom-domain clinicA.seqra.clinikally.work] [--copy-data true|false]",
  );
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return {
    name: args.name,
    subdomain: args.subdomain,
    customDomain: args["custom-domain"] || null,
    copyData: args["copy-data"] !== "false",
  };
}

function randomId() {
  return crypto.randomUUID();
}

function randomInviteHash() {
  return crypto.randomUUID();
}

function randomSchemaName() {
  return `workspace_${crypto.randomBytes(12).toString("hex")}`;
}

function sqlString(value: string | null) {
  if (value === null) {
    return "NULL";
  }

  return `'${value.replace(/'/g, "''")}'`;
}

async function runPsql(query: string) {
  await client.query(query);
}

async function queryRows<T extends QueryResultRow>(query: string): Promise<T[]> {
  const result = await client.query<T>(query);
  return result.rows;
}

async function getSourceWorkspace(): Promise<WorkspaceRow> {
  const whereClauses: string[] = [];

  if (SOURCE_WORKSPACE_ID) {
    whereClauses.push(`id = '${SOURCE_WORKSPACE_ID.replace(/'/g, "''")}'`);
  }

  if (SOURCE_WORKSPACE_SCHEMA) {
    whereClauses.push(`"databaseSchema" = '${SOURCE_WORKSPACE_SCHEMA.replace(/'/g, "''")}'`);
  }

  if (SOURCE_WORKSPACE_SUBDOMAIN) {
    whereClauses.push(`subdomain = '${SOURCE_WORKSPACE_SUBDOMAIN.replace(/'/g, "''")}'`);
  }

  const whereSql = whereClauses.length > 0 ? whereClauses.join(" OR ") : 'subdomain = \'clinikally\'';

  const rows = await queryRows<WorkspaceRow>(`
    SELECT id, "displayName", "databaseSchema", subdomain, "customDomain", "defaultRoleId"
    FROM core.workspace
    WHERE ${whereSql}
    LIMIT 1;
  `);

  if (rows.length === 0) {
    throw new Error("Source workspace not found. Set SOURCE_WORKSPACE_ID or SOURCE_WORKSPACE_SUBDOMAIN.");
  }

  return rows[0];
}

async function ensureWorkspaceDoesNotExist(subdomain: string, customDomain: string | null) {
  const clauses = [`subdomain = '${subdomain.replace(/'/g, "''")}'`];

  if (customDomain) {
    clauses.push(`"customDomain" = '${customDomain.replace(/'/g, "''")}'`);
  }

  const rows = await queryRows<{ id: string }>(`
    SELECT id
    FROM core.workspace
    WHERE ${clauses.join(" OR ")}
    LIMIT 1;
  `);

  if (rows.length > 0) {
    throw new Error(`Workspace already exists for subdomain/custom domain: ${subdomain}`);
  }
}

async function cloneWorkspaceSchema(sourceSchema: string, targetSchema: string) {
  const tables = await queryRows<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${sourceSchema}'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  if (tables.length === 0) {
    throw new Error(`No tables found in source schema ${sourceSchema}`);
  }

  await runPsql(`CREATE SCHEMA "${targetSchema}";`);

  for (const { table_name: tableName } of tables) {
    await runPsql(`CREATE TABLE "${targetSchema}"."${tableName}" (LIKE "${sourceSchema}"."${tableName}" INCLUDING ALL);`);
  }

  const sequences = await queryRows<{ sequence_name: string }>(`
    SELECT sequence_name
    FROM information_schema.sequences
    WHERE sequence_schema = '${sourceSchema}'
    ORDER BY sequence_name;
  `);

  for (const { sequence_name: sequenceName } of sequences) {
    await runPsql(`CREATE SEQUENCE "${targetSchema}"."${sequenceName}";`);
  }

  const enums = await queryRows<{ typname: string; labels: string }>(`
    SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = '${sourceSchema}'
    GROUP BY t.typname
    ORDER BY t.typname;
  `);

  for (const enumType of enums) {
    await runPsql(`CREATE TYPE "${targetSchema}"."${enumType.typname}" AS ENUM (${enumType.labels});`);
  }
}

async function copyWorkspaceSchemaData(sourceSchema: string, targetSchema: string, copyData: boolean) {
  const tables = await queryRows<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${sourceSchema}'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `);

  for (const { table_name: tableName } of tables) {
    if (!copyData && !["workflow", "workflowVersion", "workflowAutomatedTrigger"].includes(tableName)) {
      continue;
    }

    await runPsql(`INSERT INTO "${targetSchema}"."${tableName}" SELECT * FROM "${sourceSchema}"."${tableName}";`);
  }
}

async function cloneCoreWorkspaceRecords(source: WorkspaceRow, target: { id: string; name: string; subdomain: string; customDomain: string | null; schema: string; }) {
  const targetWorkspaceId = target.id;
  const targetSchema = target.schema;
  const targetSubdomain = target.subdomain;
  const targetCustomDomain = target.customDomain;
  const targetDisplayName = target.name;
  const inviteHash = randomInviteHash();

  await runPsql(`
    INSERT INTO core.workspace (
      id,
      "displayName",
      logo,
      "inviteHash",
      "deletedAt",
      "createdAt",
      "updatedAt",
      "allowImpersonation",
      "isPublicInviteLinkEnabled",
      "activationStatus",
      "metadataVersion",
      "databaseSchema",
      subdomain,
      "customDomain",
      "isGoogleAuthEnabled",
      "isTwoFactorAuthenticationEnforced",
      "isPasswordAuthEnabled",
      "isMicrosoftAuthEnabled",
      "isCustomDomainEnabled",
      "defaultRoleId",
      "trashRetentionDays",
      "routerModel",
      "isGoogleAuthBypassEnabled",
      "isPasswordAuthBypassEnabled",
      "isMicrosoftAuthBypassEnabled",
      "workspaceCustomApplicationId",
      "editableProfileFields",
      "fastModel",
      "smartModel",
      "eventLogRetentionDays",
      "suspendedAt",
      "aiAdditionalInstructions",
      "logoFileId",
      "enabledAiModelIds",
      "useRecommendedModels",
      "isInternalMessagesImportEnabled"
    )
    SELECT
      '${targetWorkspaceId}',
      ${sqlString(targetDisplayName)},
      logo,
      ${sqlString(inviteHash)},
      NULL,
      NOW(),
      NOW(),
      "allowImpersonation",
      "isPublicInviteLinkEnabled",
      'ACTIVE',
      "metadataVersion",
      ${sqlString(targetSchema)},
      ${sqlString(targetSubdomain)},
      ${sqlString(targetCustomDomain)},
      "isGoogleAuthEnabled",
      "isTwoFactorAuthenticationEnforced",
      "isPasswordAuthEnabled",
      "isMicrosoftAuthEnabled",
      ${targetCustomDomain ? "true" : '"isCustomDomainEnabled"'},
      "defaultRoleId",
      "trashRetentionDays",
      "routerModel",
      "isGoogleAuthBypassEnabled",
      "isPasswordAuthBypassEnabled",
      "isMicrosoftAuthBypassEnabled",
      "workspaceCustomApplicationId",
      "editableProfileFields",
      "fastModel",
      "smartModel",
      "eventLogRetentionDays",
      NULL,
      "aiAdditionalInstructions",
      "logoFileId",
      "enabledAiModelIds",
      "useRecommendedModels",
      "isInternalMessagesImportEnabled"
    FROM core.workspace
    WHERE id = '${source.id}';
  `);

  const tablesToClone = [
    'core."dataSource"',
    'core."objectMetadata"',
    'core."fieldMetadata"',
    'core.role',
    'core."rolePermissionFlag"',
    'core."roleTarget"',
    'core.view',
    'core."viewField"',
    'core."viewFieldGroup"',
    'core."viewFilter"',
    'core."viewFilterGroup"',
    'core."viewGroup"',
    'core."viewSort"',
    'core.webhook',
    'core.application',
    'core."applicationVariable"',
    'core.agent',
  ];

  for (const table of tablesToClone) {
    await runPsql(`
      INSERT INTO ${table}
      SELECT *
      FROM ${table}
      WHERE "workspaceId" = '${source.id}';
    `);

    await runPsql(`
      UPDATE ${table}
      SET "workspaceId" = '${targetWorkspaceId}'
      WHERE "workspaceId" = '${source.id}';
    `);
  }
}

async function main() {
  console.log("Starting main function", process.argv.slice(2));
  const { name, subdomain, customDomain, copyData } = parseArgs(process.argv.slice(2));

  if (!name || !subdomain) {
    usage();
    process.exit(1);
  }

  const source = await getSourceWorkspace();
  const targetWorkspaceId = randomId();
  const targetSchema = randomSchemaName();

  console.log(`Cloning workspace ${source.id} (${source.databaseSchema}) to ${subdomain}...`);

  await client.connect();
  console.log("Connected to database");

  await ensureWorkspaceDoesNotExist(subdomain, customDomain);
  await cloneWorkspaceSchema(source.databaseSchema, targetSchema);
  await copyWorkspaceSchemaData(source.databaseSchema, targetSchema, copyData);
  await cloneCoreWorkspaceRecords(source, {
    id: targetWorkspaceId,
    name,
    subdomain,
    customDomain,
    schema: targetSchema,
  });

  console.log("✅ Workspace clone complete");
  console.log(`Workspace ID: ${targetWorkspaceId}`);
  console.log(`Schema: ${targetSchema}`);
  console.log(`Subdomain: ${subdomain}`);
  if (customDomain) {
    console.log(`Custom domain: ${customDomain}`);
  }
  
  await client.end();
}

main().catch((error) => {
  console.error("❌ Workspace clone failed");
  console.error(error);
  process.exit(1);
});
