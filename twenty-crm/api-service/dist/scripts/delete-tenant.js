import process from "node:process";
import pg from "pg";
const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });
function getArg(name) {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1)
        return null;
    return process.argv[index + 1] ?? null;
}
async function run(query, values) {
    return client.query(query, values);
}
async function main() {
    const subdomain = getArg("subdomain");
    if (!subdomain) {
        throw new Error("Usage: npx tsx scripts/delete-tenant.ts --subdomain clinicdemo");
    }
    await client.connect();
    const result = await client.query(`SELECT id, "databaseSchema" FROM core.workspace WHERE subdomain = $1 LIMIT 1`, [subdomain]);
    if (result.rows.length === 0) {
        console.log(`Workspace with subdomain ${subdomain} not found.`);
        await client.end();
        return;
    }
    const workspace = result.rows[0];
    console.log(`Deleting workspace: ${subdomain} (ID: ${workspace.id})`);
    console.log(`Dropping schema: ${workspace.databaseSchema}`);
    await run("BEGIN");
    try {
        // 1. Drop the tenant schema
        await run(`DROP SCHEMA IF EXISTS "${workspace.databaseSchema}" CASCADE`);
        // 2. The core.workspace record delete will CASCADE to core.userWorkspace, core.role, etc
        // if constraints are set up correctly. If not, we might need to manually delete from those.
        // Twenty usually uses CASCADE for workspace deletion.
        await run(`DELETE FROM core.workspace WHERE id = $1`, [workspace.id]);
        await run("COMMIT");
        console.log(`✅ Workspace ${subdomain} deleted successfully.`);
    }
    catch (error) {
        await run("ROLLBACK");
        console.error(`❌ Failed to delete workspace:`, error.message);
    }
    finally {
        await client.end();
    }
}
main().catch(async (error) => {
    console.error("❌ Failed:", error.message);
    process.exit(1);
});
