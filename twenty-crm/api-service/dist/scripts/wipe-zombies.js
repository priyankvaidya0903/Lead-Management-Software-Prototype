import process from "node:process";
import pg from "pg";
const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL ||
    process.env.DATABASE_URL ||
    "postgres://postgres:secure_postgres_pass_123@db:5432/default";
const client = new Client({ connectionString: DATABASE_URL });
async function run(query, values) {
    return client.query(query, values);
}
async function main() {
    await client.connect();
    const ids = [
        '1b971715-5035-4f6f-86f5-700644e3fe71',
        '7749a722-85b2-416c-b3d0-09f162f48cc8',
        'b2fc53b5-d752-41f3-9ba2-20eafe882b7f'
    ];
    console.log("Removing broken zombie workspaces that are crashing the UpgradeRunner...");
    for (const id of ids) {
        const res = await client.query(`SELECT "databaseSchema", subdomain FROM core.workspace WHERE id = $1`, [id]);
        if (res.rows.length > 0) {
            const { databaseSchema, subdomain } = res.rows[0];
            console.log(`Deleting broken workspace: ${subdomain} (${id})`);
            try {
                await run("BEGIN");
                await run(`DROP SCHEMA IF EXISTS "${databaseSchema}" CASCADE`);
                await run(`DELETE FROM core.workspace WHERE id = $1`, [id]);
                await run("COMMIT");
                console.log(`✅ Cleaned up ${subdomain}`);
            }
            catch (e) {
                await run("ROLLBACK");
                console.error(`❌ Failed to cleanup ${subdomain}:`, e.message);
            }
        }
        else {
            console.log(`Workspace ${id} already deleted.`);
        }
    }
    await client.end();
}
main().catch(async (error) => {
    console.error("❌ Failed:", error.message);
    process.exit(1);
});
