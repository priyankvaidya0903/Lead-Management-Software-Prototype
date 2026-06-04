/**
 * clean-workspace.ts
 *
 * Removes ALL broken/cloned metadata from a target workspace so the
 * Twenty CRM server can boot without FlatEntityMapsException crashes.
 *
 * Usage:
 *   npx tsx scripts/clean-workspace.ts --subdomain dermaclinic
 *
 * After running:
 *   1. sudo docker-compose exec redis redis-cli flushall
 *   2. sudo docker-compose restart server
 *   3. Server will boot cleanly. Then run setup-tenant-api.ts to create custom objects.
 */
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const DATABASE_URL =
  process.env.PG_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/default";

const client = new Client({ connectionString: DATABASE_URL });

function getArg(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? null : process.argv[idx + 1] ?? null;
}

type Row = Record<string, any>;

async function query<T = Row>(sql: string, values?: any[]): Promise<T[]> {
  const res = await client.query(sql, values);
  return res.rows;
}

async function run(sql: string, values?: any[]) {
  return client.query(sql, values);
}

// ─── Core metadata tables in safe deletion order (children first) ───
const CORE_METADATA_TABLES = [
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
  'core."relationMetadata"',
  'core.relation',
  'core."indexMetadata"',
  'core.index',
  'core."fieldMetadata"',
  'core."objectMetadata"',
  'core."dataSource"',
  'core.webhook',
  'core.agent',
  'core."applicationVariable"',
  'core.application',
];

async function tableExists(tableName: string): Promise<boolean> {
  const clean = tableName.replace('core."', "").replace('"', "");
  const res = await query<{ count: string }>(
    `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'core' AND table_name = $1`,
    [clean],
  );
  return Number(res[0].count) > 0;
}

async function main() {
  const subdomain = getArg("subdomain");
  if (!subdomain) {
    console.error("Usage: npx tsx scripts/clean-workspace.ts --subdomain <subdomain>");
    process.exit(1);
  }

  await client.connect();

  // 1. Resolve workspace
  const workspaces = await query(
    `SELECT id, "databaseSchema", subdomain, "displayName", "workspaceCustomApplicationId"
     FROM core.workspace WHERE subdomain = $1 LIMIT 1`,
    [subdomain],
  );

  if (workspaces.length === 0) {
    console.error(`❌ Workspace not found for subdomain: ${subdomain}`);
    process.exit(1);
  }

  const ws = workspaces[0];
  console.log(`Workspace: ${ws.displayName} (${ws.id})`);
  console.log(`Schema:    ${ws.databaseSchema}`);

  await run("BEGIN");
  await run("SET LOCAL session_replication_role = 'replica'");

  // 2. Delete ALL core metadata for this workspace
  console.log("\n── Deleting core metadata ──");
  for (const table of CORE_METADATA_TABLES) {
    if (!(await tableExists(table))) {
      console.log(`  SKIP ${table} (does not exist)`);
      continue;
    }

    // Check if the table has a workspaceId column
    const clean = table.replace('core."', "").replace('"', "");
    const hasWorkspaceId = await query<{ count: string }>(
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = $1 AND column_name = 'workspaceId'`,
      [clean],
    );

    if (Number(hasWorkspaceId[0].count) > 0) {
      const res = await run(`DELETE FROM ${table} WHERE "workspaceId" = $1`, [ws.id]);
      console.log(`  ✅ ${table}: deleted ${res.rowCount} rows`);
    } else {
      console.log(`  SKIP ${table} (no workspaceId column)`);
    }
  }

  // 3. Replace the custom application with a fresh placeholder
  //    (workspaceCustomApplicationId is NOT NULL, so we can't set it to NULL)
  if (ws.workspaceCustomApplicationId) {
    const crypto = await import("node:crypto");
    const newAppId = crypto.randomUUID();

    // Check if core.application table exists before inserting
    const appTableExists = await query<{ count: string }>(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'core' AND table_name = 'application'`,
    );

    if (Number(appTableExists[0].count) > 0) {
      // Get the column list so we only insert what exists
      const appCols = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'core' AND table_name = 'application'
         ORDER BY ordinal_position`,
      );
      const colNames = appCols.map((c) => c.column_name);

      // Build a minimal insert with just id + any required columns
      const insertCols: string[] = ['"id"'];
      const insertVals: any[] = [newAppId];
      let idx = 2;

      if (colNames.includes("workspaceId")) {
        insertCols.push('"workspaceId"');
        insertVals.push(ws.id);
        idx++;
      }
      if (colNames.includes("createdAt")) {
        insertCols.push('"createdAt"');
        insertVals.push(new Date());
        idx++;
      }
      if (colNames.includes("updatedAt")) {
        insertCols.push('"updatedAt"');
        insertVals.push(new Date());
        idx++;
      }
      if (colNames.includes("position")) {
        insertCols.push('"position"');
        insertVals.push(0);
        idx++;
      }

      const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(", ");
      try {
        await run(
          `INSERT INTO core.application (${insertCols.join(", ")}) VALUES (${placeholders})`,
          insertVals,
        );
        console.log(`  ✅ Created placeholder application ${newAppId}`);
      } catch (e) {
        console.log(`  ⚠️  Could not create placeholder application: ${(e as Error).message}`);
      }

      // Delete the old application
      try {
        await run(`DELETE FROM core.application WHERE id = $1`, [ws.workspaceCustomApplicationId]);
        console.log(`  ✅ Deleted old custom application ${ws.workspaceCustomApplicationId}`);
      } catch (e) {
        console.log(`  ⚠️  Could not delete old application: ${(e as Error).message}`);
      }
    }

    // Point workspace to the new placeholder app
    await run(`UPDATE core.workspace SET "workspaceCustomApplicationId" = $1 WHERE id = $2`, [newAppId, ws.id]);
    console.log(`  ✅ Updated workspace to point to new application ${newAppId}`);
  }

  // 4. Drop custom tables from the workspace schema (tables starting with _)
  console.log("\n── Cleaning workspace schema ──");
  const schemaTables = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [ws.databaseSchema],
  );

  for (const { table_name } of schemaTables) {
    if (table_name.startsWith("_")) {
      await run(`DROP TABLE IF EXISTS "${ws.databaseSchema}"."${table_name}" CASCADE`);
      console.log(`  ✅ Dropped custom table: ${table_name}`);
    }
  }

  // 5. Reset the workspace's defaultRoleId since we deleted roles
  //    (only if the column is nullable)
  try {
    await run(`UPDATE core.workspace SET "defaultRoleId" = NULL WHERE id = $1`, [ws.id]);
  } catch {
    console.log(`  ⚠️  Could not reset defaultRoleId (NOT NULL constraint), skipping`);
  }

  await run("COMMIT");

  console.log("\n✅ Workspace cleaned successfully.");
  console.log("\nNext steps:");
  console.log("  1. Flush Redis:    sudo docker-compose -f docker-compose.prod.yml exec redis redis-cli flushall");
  console.log("  2. Restart server: sudo docker-compose -f docker-compose.prod.yml restart server");
  console.log("  3. Wait for server to boot (check logs)");
  console.log(`  4. Run setup:      npx tsx scripts/setup-tenant-api.ts --source-subdomain aayna --target-subdomain ${subdomain}`);

  await client.end();
}

main().catch(async (e: Error) => {
  try { await run("ROLLBACK"); } catch {}
  await client.end().catch(() => {});
  console.error("❌ Failed:", e.message);
  process.exit(1);
});
