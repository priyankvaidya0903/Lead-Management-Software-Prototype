import crypto from 'node:crypto';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const DATABASE_URL = process.env.PG_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/default';
const client = new Client({ connectionString: DATABASE_URL });

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function runPsql(query) { await client.query(query); }
async function queryRows(query) { const result = await client.query(query); return result.rows; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args.name;
  const subdomain = args.subdomain;
  
  console.log('🚀 Connecting to database...');
  await client.connect();
  console.log('✅ Connected.');

  const source = (await queryRows(`SELECT id, "databaseSchema" FROM core.workspace WHERE subdomain = 'clinikally' LIMIT 1;`))[0];
  if (!source) throw new Error('Source workspace clinikally not found.');

  const targetWorkspaceId = crypto.randomUUID();
  const targetSchema = `workspace_${crypto.randomBytes(12).toString('hex')}`;
  console.log(`Cloning ${source.databaseSchema} -> ${targetSchema}...`);

