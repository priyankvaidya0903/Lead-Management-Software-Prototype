import crypto from "node:crypto";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL || process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });

// Use parameterized queries for DDL/simple SQL
async function runPsql(query: string) { 
  try {
    await client.query(query); 
  } catch (err: any) {
    console.error(`\n🚨 SQL ERROR 🚨`);
    console.error(`Error: ${err.message}`);
    if (err.constraint) {
      console.error(`Constraint: ${err.constraint}`);
    }
    throw err;
  }
}

async function insertRow(table: string, colNames: string[], values: any[]) {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const colsSql = colNames.map(c => `"${c}"`).join(', ');
  const query = `INSERT INTO ${table} (${colsSql}) VALUES (${placeholders});`;
  try {
    await client.query(query, values);
  } catch (err: any) {
    console.error(`\n🚨 SQL ERROR 🚨`);
    console.error(`Error: ${err.message}`);
    console.error(`Table: ${table}`);
    if (err.constraint) {
      console.error(`Constraint: ${err.constraint}`);
    }
    throw err;
  }
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

  await runPsql("BEGIN;");

  // Disable ALL foreign key checks for the entire transaction (requires superuser)
  // This completely bypasses all FK ordering issues for both deletes and inserts
  await runPsql("SET LOCAL session_replication_role = 'replica';");

  // Clean up: if a workspace with this subdomain already exists (from a failed run), delete it
  const existing = await queryRows(`SELECT id, "databaseSchema" FROM core.workspace WHERE subdomain = '${subdomain}';`);
  if (existing.length > 0) {
    console.log(`🧹 Found existing workspace for subdomain "${subdomain}", cleaning up...`);
    for (const old of existing) {
      const coreTables = [
        'core.agent', 'core.webhook',
        'core."viewSort"', 'core."viewGroup"', 'core."viewFilter"', 'core."viewFilterGroup"',
        'core."viewField"', 'core."viewFieldGroup"', 'core.view',
        'core."roleTarget"', 'core."rolePermissionFlag"', 'core.role',
        'core."fieldMetadata"', 'core."objectMetadata"', 'core."dataSource"',
        'core."applicationVariable"', 'core.application',
      ];
      for (const t of coreTables) {
        await client.query(`DELETE FROM ${t} WHERE "workspaceId" = $1`, [old.id]).catch(() => {});
      }
      if (old.databaseSchema) {
        await client.query(`DROP SCHEMA IF EXISTS "${old.databaseSchema}" CASCADE`).catch(() => {});
      }
      await client.query(`DELETE FROM core.workspace WHERE id = $1`, [old.id]);
      console.log(`  🗑️ Deleted old workspace ${old.id} (${old.databaseSchema})`);
    }
  }

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

  // Clone schema structure
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

  // Copy workspace data (use server-side SQL copy to avoid type issues)
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





  


  // Clone workspace record dynamically to ensure all columns (even newly added ones) are copied
  const workspaceRows = await queryRows(`SELECT * FROM core.workspace WHERE id = '${source.id}';`);
  const wRow = workspaceRows[0];
  wRow.id = targetWorkspaceId;
  wRow.displayName = name;
  wRow.inviteHash = crypto.randomUUID();
  wRow.databaseSchema = targetSchema;
  wRow.subdomain = subdomain;
  wRow.createdAt = new Date();
  wRow.updatedAt = new Date();
  wRow.deletedAt = null;
  wRow.logoFileId = null;
  wRow.customDomain = null;

  // Initialize idMap early to map the unique application ID
  const idMap = new Map<string, string>();
  idMap.set(source.id, targetWorkspaceId);

  if (wRow.workspaceCustomApplicationId) {
    const newAppId = crypto.randomUUID();
    idMap.set(wRow.workspaceCustomApplicationId, newAppId);
    wRow.workspaceCustomApplicationId = newAppId;
  }

  const wCols = await queryRows<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'workspace' AND is_generated = 'NEVER';`);
  const wColTypeMap = new Map<string, string>();
  for (const c of wCols) {
    wColTypeMap.set(c.column_name, c.data_type);
  }

  const wColNames = [];
  const wValues = [];
  const wPlaceholders = [];
  let wIdx = 1;
  for (const [key, value] of Object.entries(wRow)) {
    if (wColTypeMap.has(key)) {
      wColNames.push(`"${key}"`);
      const dtype = wColTypeMap.get(key)!;
      if (dtype === 'json' || dtype === 'jsonb') {
        if (value === null || value === undefined) {
          wValues.push(null);
          wPlaceholders.push(`$${wIdx}::jsonb`);
        } else {
          wValues.push(JSON.stringify(value));
          wPlaceholders.push(`$${wIdx}::jsonb`);
        }
      } else {
        wValues.push(value);
        wPlaceholders.push(`$${wIdx}`);
      }
      wIdx++;
    }
  }
  
  try {
    await client.query(`INSERT INTO core.workspace (${wColNames.join(', ')}) VALUES (${wPlaceholders.join(', ')});`, wValues);
  } catch (err: any) {
    console.error(`\n🚨 SQL ERROR on core.workspace INSERT 🚨`);
    console.error(`Error: ${err.message}`);
    if (err.constraint) {
      console.error(`Constraint: ${err.constraint}`);
    }
    throw err;
  }

  // Tables to clone with their dependencies in correct order
  const tablesToClone = [
    'core."userWorkspace"',
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
    const tRows = await queryRows(`SELECT * FROM ${table} WHERE "workspaceId" = '${source.id}';`);
    tableData[table] = tRows;
    console.log(`  Fetched ${tRows.length} rows from ${table}`);
  }

  // 2. Generate new IDs and map them (preserving any early mappings like workspaceCustomApplicationId)
  for (const table of tablesToClone) {
    for (const row of tableData[table]) {
      if (row.id && !idMap.has(row.id)) {
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
      
      // Handle core.application unique constraints
      if (table === 'core.application') {
        if (row.universalIdentifier) row.universalIdentifier = crypto.randomUUID();
        if (row.packageJsonFileId) row.packageJsonFileId = null;
        if (row.yarnLockFileId) row.yarnLockFileId = null;
      }
    }
  }

  // 4. Insert rows using PARAMETERIZED QUERIES with explicit jsonb casts
  for (const table of tablesToClone) {
    const tRows = tableData[table];
    if (tRows.length === 0) continue;

    const schemaName = table.split('.')[0];
    const tableNameClean = table.split('.')[1].replace(/"/g, "");

    const columns = await queryRows<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = '${schemaName}'
        AND table_name = '${tableNameClean}'
        AND is_generated = 'NEVER';
    `);
    const colTypeMap = new Map<string, string>();
    for (const c of columns) {
      colTypeMap.set(c.column_name, c.data_type);
    }

    for (const row of tRows) {
      const colNames: string[] = [];
      const values: any[] = [];
      const placeholders: string[] = [];
      let idx = 1;
      for (const [key, value] of Object.entries(row)) {
        if (colTypeMap.has(key)) {
          colNames.push(`"${key}"`);
          const dtype = colTypeMap.get(key)!;
          if (dtype === 'json' || dtype === 'jsonb') {
            if (value === null || value === undefined) {
              values.push(null);
              placeholders.push(`$${idx}::jsonb`);
            } else {
              // ALWAYS JSON.stringify for jsonb — turns JS string 'uuid' into '"uuid"',
              // number 0 into '0', object {} into '{}', etc. All valid JSON.
              values.push(JSON.stringify(value));
              placeholders.push(`$${idx}::jsonb`);
            }
          } else {
            values.push(value);
            placeholders.push(`$${idx}`);
          }
          idx++;
        }
      }
      const query = `INSERT INTO ${table} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')});`;
      try {
        await client.query(query, values);
      } catch (err: any) {
        console.error(`\n🚨 SQL ERROR 🚨`);
        console.error(`Error: ${err.message}`);
        console.error(`Table: ${table}`);
        if (err.constraint) {
          console.error(`Constraint: ${err.constraint}`);
        }
        throw err;
      }
    }
    console.log(`  ✅ Inserted ${tRows.length} rows into ${table}`);
  }

  console.log("✅ Mapping old core IDs to new core IDs inside the tenant schema...");
  for (const { table_name } of tables) {
    const uuidCols = await queryRows<{ column_name: string }>(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = '${targetSchema}' 
        AND table_name = '${table_name}' 
        AND data_type = 'uuid';
    `);

    if (uuidCols.length > 0) {
      // Build a temporary mapping table in memory to bulk update
      const mappings = Array.from(idMap.entries());
      if (mappings.length > 0) {
        // Create a temporary table for the map to do a fast join update
        await runPsql(`CREATE TEMP TABLE id_map_temp (old_id uuid, new_id uuid) ON COMMIT DROP;`);
        
        // Insert in batches of 1000
        for (let i = 0; i < mappings.length; i += 1000) {
          const batch = mappings.slice(i, i + 1000);
          const vals = batch.map(m => `('${m[0]}', '${m[1]}')`).join(',');
          await runPsql(`INSERT INTO id_map_temp (old_id, new_id) VALUES ${vals};`);
        }

        for (const col of uuidCols) {
          await runPsql(`
            UPDATE "${targetSchema}"."${table_name}" t
            SET "${col.column_name}" = m.new_id
            FROM id_map_temp m
            WHERE t."${col.column_name}" = m.old_id;
          `);
        }
        await runPsql(`DROP TABLE id_map_temp;`);
      }
    }
  }

  await runPsql("COMMIT;");

  console.log("\n✅ Workspace clone complete!");
  console.log(`Workspace ID: ${targetWorkspaceId}`);
  console.log(`Subdomain: ${subdomain}`);
  console.log(`Schema: ${targetSchema}`);
  await client.end();
}

main().catch(async (err: any) => {
  try {
    await client.query("ROLLBACK;");
  } catch {}
  await client.end().catch(() => {});
  console.error("❌ Failed:", err.message);
  process.exit(1);
});
