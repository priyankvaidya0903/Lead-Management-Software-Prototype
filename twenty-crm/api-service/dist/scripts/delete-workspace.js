import process from "node:process";
import pg from "pg";
const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });
async function main() {
    await client.connect();
    const targetSubdomain = process.argv[2] || "dermaclinic";
    console.log(`\nChecking for ghost workspace: ${targetSubdomain} ...`);
    try {
        const res = await client.query(`SELECT id, "databaseSchema" FROM core.workspace WHERE subdomain = $1`, [targetSubdomain]);
        if (res.rows.length === 0) {
            console.log(`\n✅ Workspace ${targetSubdomain} does not exist (already deleted).`);
            return;
        }
        const ws = res.rows[0];
        console.log(`\nNuking ghost workspace... ID: ${ws.id}`);
        // Hard delete the workspace row (cascades or orphans other core rows)
        await client.query(`DELETE FROM core.workspace WHERE id = $1`, [ws.id]);
        // Drop the custom schema
        await client.query(`DROP SCHEMA IF EXISTS "${ws.databaseSchema}" CASCADE`);
        console.log(`\n✅ Ghost workspace completely deleted! You can now sign up fresh.`);
    }
    catch (e) {
        console.error("Error running query:", e.message);
    }
    finally {
        await client.end();
    }
}
main().catch(() => { });
