import fs from "fs";
import { parse } from "csv-parse/sync";

// Default configuration for the CRM schema
const DEFAULT_CONFIG = {
  targetObject: "leadss",
  uniqueBy: ["email", "phone"],
  fieldMap: {
    "Name": "name",
    "Email": "email",
    "Phone": "phone",
    "Status": "stage",
    "Source": "source",
    "Product": "treatment",
    "City": "city",
    "Lead ID": "legacyId",
    "Assigned User": "assignedUser"
  },
  defaults: {
    // any default values you want to set for new records
  },
  dryRun: true // Defaulting to dry run so it doesn't modify data by default
};

async function run() {
  const args = process.argv.slice(2);
  const csvFilePath = args[0];
  const apiUrl = args[1] || "http://localhost:3002/crm-api/migration/run";

  if (!csvFilePath) {
    console.error("Usage: npx tsx scripts/run-migration.ts <path-to-csv> [migration-endpoint-url]");
    process.exit(1);
  }

  if (!fs.existsSync(csvFilePath)) {
    console.error(`File not found: ${csvFilePath}`);
    process.exit(1);
  }

  console.log(`Reading CSV from ${csvFilePath}...`);
  const fileContent = fs.readFileSync(csvFilePath, "utf8");
  
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true, // This automatically removes extra spaces in CSV headers like " Name"
  });

  console.log(`Parsed ${records.length} records. Sending to migration endpoint...`);

  const payload = {
    records,
    config: DEFAULT_CONFIG,
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API Error ${response.status}: ${text}`);
    }

    const data = await response.json();
    console.log("Migration Complete!");
    console.log(JSON.stringify(data.summary, null, 2));

    if (DEFAULT_CONFIG.dryRun) {
      console.log("\nDry Run Mode ON. No records were modified.");
      console.log("To perform actual migration, change 'dryRun: false' in scripts/run-migration.ts");
    } else {
      console.log("\nResults written.");
    }
    
    // Optionally log a few output items to see the results
    if (data.output && data.output.length > 0) {
      console.log("\nSample Output:");
      console.log(JSON.stringify(data.output.slice(0, 2), null, 2));
    }

  } catch (error) {
    console.error("Migration failed:", error);
  }
}

run();
