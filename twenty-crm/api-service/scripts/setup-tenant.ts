import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL =
  process.env.PG_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });

type Row = Record<string, any>;

type WorkspaceRef = {
  id: string;
  databaseSchema: string;
  subdomain: string | null;
  displayName: string;
  defaultRoleId: string | null;
};

function getArg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function run(query: string, values?: any[]) {
  return client.query(query, values);
}

async function rows<T = Row>(query: string, values?: any[]): Promise<T[]> {
  const result = await client.query(query, values);
  return result.rows;
}

async function getWorkspaceBySubdomain(subdomain: string): Promise<WorkspaceRef> {
  const result = await rows<WorkspaceRef>(
    `SELECT id, "databaseSchema", subdomain, "displayName", "defaultRoleId"
     FROM core.workspace
     WHERE subdomain = $1
     LIMIT 1`,
    [subdomain],
  );

  if (result.length === 0) {
    throw new Error(`Workspace not found for subdomain: ${subdomain}`);
  }

  return result[0];
}

async function getBaseTables(schema: string) {
  return rows<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = $1
       AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
}

async function getTableColumns(schema: string, table: string) {
  return rows<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema = $1
       AND table_name = $2
       AND is_generated = 'NEVER'
     ORDER BY ordinal_position`,
    [schema, table],
  );
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function recreateTargetSchemaFromSource(sourceSchema: string, targetSchema: string) {
  await run(`DROP SCHEMA IF EXISTS ${quoteIdentifier(targetSchema)} CASCADE`);
  await run(`CREATE SCHEMA ${quoteIdentifier(targetSchema)}`);

  const enums = await rows<{ typname: string; labels: string }>(
    `SELECT t.typname, string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder) AS labels
     FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1
     GROUP BY t.typname
     ORDER BY t.typname`,
    [sourceSchema],
  );

  for (const enumType of enums) {
    await run(`CREATE TYPE ${quoteIdentifier(targetSchema)}.${quoteIdentifier(enumType.typname)} AS ENUM (${enumType.labels})`);
  }

  const tables = await getBaseTables(sourceSchema);
  for (const { table_name } of tables) {
    await run(
      `CREATE TABLE ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table_name)} (LIKE ${quoteIdentifier(sourceSchema)}.${quoteIdentifier(table_name)} INCLUDING ALL)`,
    );
  }

  const sequences = await rows<{ sequence_name: string }>(
    `SELECT sequence_name
     FROM information_schema.sequences
     WHERE sequence_schema = $1
     ORDER BY sequence_name`,
    [sourceSchema],
  );

  for (const sequence of sequences) {
    await run(`CREATE SEQUENCE ${quoteIdentifier(targetSchema)}.${quoteIdentifier(sequence.sequence_name)}`);
  }

  for (const { table_name } of tables) {
    const columns = await getTableColumns(sourceSchema, table_name);
    if (columns.length === 0) continue;

    const columnSql = columns.map((column) => quoteIdentifier(column.column_name)).join(", ");
    await run(
      `INSERT INTO ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table_name)} (${columnSql})
       SELECT ${columnSql}
       FROM ${quoteIdentifier(sourceSchema)}.${quoteIdentifier(table_name)}`,
    );
  }
}

async function deleteTargetCoreData(targetWorkspaceId: string) {
  const tables = [
    'core."viewSort"',
    'core."viewGroup"',
    'core."viewFilter"',
    'core."viewFilterGroup"',
    'core."viewField"',
    'core."viewFieldGroup"',
    'core.view',
    'core."roleTarget"',
    'core."rolePermissionFlag"',
    'core.role',
    'core."fieldMetadata"',
    'core."objectMetadata"',
    'core."dataSource"',
    'core.webhook',
    'core.agent',
    'core."applicationVariable"',
    'core.application',
  ];

  for (const table of tables) {
    await run(`DELETE FROM ${table} WHERE "workspaceId" = $1`, [targetWorkspaceId]);
  }
}

async function fetchWorkspaceRows(table: string, workspaceId: string) {
  return rows<Row>(`SELECT * FROM ${table} WHERE "workspaceId" = $1`, [workspaceId]);
}

async function getColumnTypes(table: string) {
  const [schemaNameRaw, tableNameRaw] = table.split(".");
  const schemaName = schemaNameRaw.replace(/"/g, "");
  const tableName = tableNameRaw.replace(/"/g, "");
  return getTableColumns(schemaName, tableName);
}

async function insertRows(table: string, data: Row[]) {
  if (data.length === 0) return;

  const columnTypes = await getColumnTypes(table);
  const allowedColumns = new Map(columnTypes.map((column) => [column.column_name, column.data_type]));

  for (const row of data) {
    const colNames: string[] = [];
    const values: any[] = [];
    const placeholders: string[] = [];
    let index = 1;

    for (const [key, value] of Object.entries(row)) {
      const dataType = allowedColumns.get(key);
      if (!dataType) continue;

      colNames.push(quoteIdentifier(key));
      if (dataType === "json" || dataType === "jsonb") {
        values.push(value == null ? null : JSON.stringify(value));
        placeholders.push(`$${index}::jsonb`);
      } else {
        values.push(value);
        placeholders.push(`$${index}`);
      }
      index += 1;
    }

    await run(`INSERT INTO ${table} (${colNames.join(", ")}) VALUES (${placeholders.join(", ")})`, values);
  }
}

async function cloneCoreWorkspaceData(sourceWorkspaceId: string, targetWorkspaceId: string) {
  const tables = [
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
    'core.agent',
  ];

  const dataByTable: Record<string, Row[]> = {};
  const idMap = new Map<string, string>();

  idMap.set(sourceWorkspaceId, targetWorkspaceId);

  for (const table of tables) {
    const tableRows = await fetchWorkspaceRows(table, sourceWorkspaceId);
    dataByTable[table] = tableRows;

    for (const row of tableRows) {
      if (row.id) {
        idMap.set(row.id, crypto.randomUUID());
      }
    }
  }

  for (const table of tables) {
    for (const row of dataByTable[table]) {
      for (const [key, value] of Object.entries(row)) {
        if (typeof value === "string" && idMap.has(value)) {
          row[key] = idMap.get(value);
        }
      }

      row.workspaceId = targetWorkspaceId;

      if (table === "core.application") {
        row.packageJsonFileId = null;
        row.yarnLockFileId = null;
      }
    }
  }

  for (const table of tables) {
    await insertRows(table, dataByTable[table]);
  }

  return idMap;
}

async function remapSchemaUuids(targetSchema: string, idMap: Map<string, string>) {
  const tables = await getBaseTables(targetSchema);

  await run(`CREATE TEMP TABLE id_map_temp (old_id uuid, new_id uuid) ON COMMIT DROP`);

  const mappings = Array.from(idMap.entries());
  for (const [oldId, newId] of mappings) {
    await run(`INSERT INTO id_map_temp (old_id, new_id) VALUES ($1, $2)`, [oldId, newId]);
  }

  for (const { table_name } of tables) {
    const uuidColumns = await rows<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
         AND data_type = 'uuid'`,
      [targetSchema, table_name],
    );

    for (const column of uuidColumns) {
      await run(
        `UPDATE ${quoteIdentifier(targetSchema)}.${quoteIdentifier(table_name)} target
         SET ${quoteIdentifier(column.column_name)} = map.new_id
         FROM id_map_temp map
         WHERE target.${quoteIdentifier(column.column_name)} = map.old_id`,
      );
    }
  }
}

async function main() {
  const sourceSubdomain = getArg("source-subdomain");
  const targetSubdomain = getArg("target-subdomain");

  if (!sourceSubdomain || !targetSubdomain) {
    throw new Error("Usage: npx tsx scripts/setup-tenant.ts --source-subdomain demo --target-subdomain clinica");
  }

  await client.connect();
  await run("BEGIN");
  await run("SET LOCAL session_replication_role = 'replica'");

  const sourceWorkspace = await getWorkspaceBySubdomain(sourceSubdomain);
  const targetWorkspace = await getWorkspaceBySubdomain(targetSubdomain);

  console.log(`Source: ${sourceWorkspace.id} (${sourceWorkspace.databaseSchema})`);
  console.log(`Target: ${targetWorkspace.id} (${targetWorkspace.databaseSchema})`);

  if (sourceWorkspace.id === targetWorkspace.id) {
    throw new Error("Source and target workspace cannot be the same");
  }

  await deleteTargetCoreData(targetWorkspace.id);
  await recreateTargetSchemaFromSource(sourceWorkspace.databaseSchema, targetWorkspace.databaseSchema);
  const idMap = await cloneCoreWorkspaceData(sourceWorkspace.id, targetWorkspace.id);
  await remapSchemaUuids(targetWorkspace.databaseSchema, idMap);

  // Restore User Access and Default Role
  if (sourceWorkspace.defaultRoleId && idMap.has(sourceWorkspace.defaultRoleId)) {
    const newRoleId = idMap.get(sourceWorkspace.defaultRoleId);
    await run(`UPDATE core.workspace SET "defaultRoleId" = $1 WHERE id = $2`, [newRoleId, targetWorkspace.id]);
    await run(`UPDATE core."userWorkspace" SET "roleId" = $1 WHERE "workspaceId" = $2`, [newRoleId, targetWorkspace.id]);
  }

  await run("COMMIT");
  console.log("✅ Clone complete into existing workspace");

  await client.end();
}

main().catch(async (error: Error) => {
  try {
    await run("ROLLBACK");
  } catch {}
  await client.end().catch(() => {});
  console.error("❌ Failed:", error.message);
  process.exit(1);
});
