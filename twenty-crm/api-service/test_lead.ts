import { getLeadDetails } from "./src/lib/twentyCrmClient.js";
import 'dotenv/config';

async function run() {
  const leadId = "24719c8f-3617-48f5-a0dd-c3359d9c2ddb"; // I need to get a real lead ID
  // Wait, I don't know a real lead ID right now.
  // I will just fetch the first lead from the database.
  
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  const url = `${apiUrl}/leadss?limit=1`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } });
  const data = await response.json();
  const lead = data.data.leadss[0];
  console.log("LEAD:", JSON.stringify(lead, null, 2));
}

run();
