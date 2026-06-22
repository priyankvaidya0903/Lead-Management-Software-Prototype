import fs from "fs";
import { parse } from "csv-parse/sync";

// Load configuration from external JSON file
const configPath = "./scripts/migration-config.json";
let MIGRATION_CONFIG: any = {};
if (fs.existsSync(configPath)) {
  MIGRATION_CONFIG = JSON.parse(fs.readFileSync(configPath, "utf8"));
  console.log("Loaded migration-config.json successfully.");
} else {
  console.error(`Migration config not found at ${configPath}. Please create it.`);
  process.exit(1);
}

// Default configuration for the CRM schema
const DEFAULT_CONFIG = {
  targetObject: "leadss",
  uniqueBy: ["email", "phone"],
  fieldMap: MIGRATION_CONFIG.fieldMap || {},
  valueMaps: MIGRATION_CONFIG.valueMaps || {},
  defaults: {
    // any default values you want to set for new records
  },
  dryRun: false // Defaulting to dry run so it doesn't modify data by default
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
  }).map((record: any) => {
    // --- STAGE MAPPING ---
    if (record.Status) {
      const statusKey = record.Status.trim().toLowerCase();
      const stageMap = MIGRATION_CONFIG.valueMaps?.stage || {};
      const mappedStage = stageMap[statusKey];
      
      if (mappedStage) {
        record.Status = mappedStage;
      } else {
        console.warn(`[Warning] Unmapped stage found: "${record.Status}". Defaulting to REQUIREMENTS_GATHERED. Please add it to migration-config.json.`);
        record.Status = "REQUIREMENTS_GATHERED";
      }
    }

    // --- SOURCE MAPPING ---
    if (record.Source) {
      const sourceKey = record.Source.trim().toLowerCase();
      const sourceMap = MIGRATION_CONFIG.valueMaps?.source1 || {};
      const mappedSource = sourceMap[sourceKey];
      
      if (mappedSource) {
        record.Source = [mappedSource]; // Twenty CRM expects an array for multi-select
      } else {
        console.warn(`[Warning] Unmapped source found: "${record.Source}". Please add it to migration-config.json.`);
        const fallback = record.Source.trim().toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_");
        record.Source = [fallback];
      }
    }

    // --- PHONE MAPPING ---
    if (record.Phone) {
      const phoneStr = String(record.Phone).trim();
      if (phoneStr.startsWith("+1")) {
        // Explicitly map US numbers so the server doesn't conflict them with +91
        record.Phone = {
          primaryPhoneNumber: phoneStr.replace("+1", ""),
          primaryPhoneCallingCode: "+1",
          primaryPhoneCountryCode: "US"
        };
      } else if (phoneStr.startsWith("+91")) {
        record.Phone = phoneStr.replace("+91", "");
      }
    }
    
    // --- TREATMENT MAPPING ---
    if (record.Product) {
      if (record.Product.toLowerCase() === "not specified" || !record.Product.trim()) {
        delete record.Product; // Don't send invalid empty treatments
      }
      // No extra formatting needed! Twenty CRM will accept the raw string into the oldCrmTreatment text field.
    }
    
    return record;
  });

  console.log(`Parsed ${records.length} records. Sending to migration endpoint in batches...`);

  const BATCH_SIZE = 10;
  let totalSummary = { total: 0, valid: 0, invalid: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    console.log(`\nSending batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(records.length / BATCH_SIZE)} (${chunk.length} records)...`);
    
    const payload = {
      records: chunk,
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
      console.log(`Batch complete. Summary:`, data.summary);
      
      // Accumulate totals
      for (const key in data.summary) {
        (totalSummary as any)[key] += data.summary[key];
      }
      
      // Prevent Rate Limiting: wait 10 seconds between batches
      if (i + BATCH_SIZE < records.length) {
        console.log("Waiting 40 seconds to prevent rate limit (429)...");
        await new Promise(resolve => setTimeout(resolve, 40000));
      }

    } catch (error) {
      console.error("Migration batch failed:", error);
    }
  }
  
  console.log("\n=== FULL MIGRATION COMPLETE ===");
  console.log(JSON.stringify(totalSummary, null, 2));

  if (DEFAULT_CONFIG.dryRun) {
    console.log("\nDry Run Mode ON. No records were modified.");
    console.log("To perform actual migration, change 'dryRun: false' in scripts/run-migration.ts");
  } else {
    console.log("\nResults successfully written to Twenty CRM.");
  }
}

run();
