require('dotenv').config({ path: '.env.local' });

async function run() {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;
  const leadId = "5ab46582-a246-4af9-98b6-2088db90150b";
  const noteId = "b4fca9f0-9ad8-44fb-91f6-870c5a3c9788"; // From previous run
  
  console.log("Creating NoteTarget with leadssId...");
  const res2 = await fetch(`${apiUrl}/noteTargets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      noteId: noteId,
      leadssId: leadId
    })
  });
  const targetData = await res2.json();
  console.log("Target response (leadssId):", JSON.stringify(targetData, null, 2));

  if (!res2.ok) {
    console.log("Creating NoteTarget with leadsId...");
    const res3 = await fetch(`${apiUrl}/noteTargets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        noteId: noteId,
        leadsId: leadId
      })
    });
    console.log("Target response (leadsId):", JSON.stringify(await res3.json(), null, 2));
  }
}
run();
