import { getLeadDetails } from "./src/lib/twentyCrmClient.js";
import 'dotenv/config';

async function run() {
  const data = await getLeadDetails("15880163-f306-4d04-9d63-699f246f6cd7");
  console.log("getLeadDetails:", JSON.stringify(data, null, 2));
}

run();
