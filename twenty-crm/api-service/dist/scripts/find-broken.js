import process from "node:process";
import pg from "pg";
const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/default";
const client = new Client({ connectionString: DATABASE_URL });
async function main() {
    await client.connect();
    const brokenId = process.argv[2] || '96e4e759-12ef-432f-b1a9-fc56aae0f629';
    console.log(`\nSearching for workspace that owns broken object: ${brokenId} ...`);
    try {
        const res = await client.query(`SELECT w.subdomain, w.id 
       FROM core."objectMetadata" o
       JOIN core.workspace w ON w.id = o."workspaceId"
       WHERE o.id = $1`, [brokenId]);
        if (res.rows.length === 0) {
            console.log(`\n❌ Object ${brokenId} not found in database.`);
        }
        else {
            console.log(`\n=========================================`);
            console.log(`✅ BROKEN WORKSPACE IS: ${res.rows[0].subdomain}`);
            console.log(`=========================================\n`);
            console.log(`Now run:`);
            console.log(`  npx tsx scripts/clean-workspace.ts --subdomain ${res.rows[0].subdomain}\n`);
        }
    }
    catch (e) {
        console.error("Error running query:", e.message);
    }
    finally {
        await client.end();
    }
}
main().catch(() => { });
