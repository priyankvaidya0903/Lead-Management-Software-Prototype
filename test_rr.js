import { getManagersForClinic } from "./twenty-crm/api-service/dist/lib/twentyCrmClient.js";
import { getNextManagerIndex } from "./twenty-crm/api-service/dist/lib/roundRobin.js";
import dotenv from "dotenv";
dotenv.config({ path: "./twenty-crm/api-service/.env" });

async function test() {
  console.log("Testing getManagersForClinic...");
  const clinicId = "fdf96b85-bb72-4e54-8877-ab53ae7c8ded"; // From previous curl
  const managers = await getManagersForClinic(clinicId);
  console.log("Managers:", managers.length);
  if (managers.length > 0) {
    const idx = await getNextManagerIndex(clinicId, managers.length);
    console.log("Next Manager Index:", idx);
    console.log("Assigned Manager:", managers[idx]);
  }
}
test();
