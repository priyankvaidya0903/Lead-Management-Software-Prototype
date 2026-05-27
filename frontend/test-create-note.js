require('dotenv').config({ path: '.env.local' });

async function run() {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;
  const leadId = "5ab46582-a246-4af9-98b6-2088db90150b";

  console.log("Creating Note...");
  const res1 = await fetch(`${apiUrl}/notes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Test Note",
      bodyV2: {
        blocknote: JSON.stringify([{ type: "paragraph", content: "Test" }])
      }
    })
  });
  const noteData = await res1.json();
  console.log("Note response:", JSON.stringify(noteData, null, 2));

  const noteId = noteData?.data?.createNote?.id ?? noteData?.data?.notes?.id ?? noteData?.data?.id ?? noteData?.id;
  if (!noteId) {
    console.log("Failed to get Note ID");
    return;
  }
  
  console.log("Creating NoteTarget with Note ID:", noteId);
  const res2 = await fetch(`${apiUrl}/noteTargets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      noteId: noteId,
      targetObjectId: leadId,
      targetObjectName: "leadss"
    })
  });
  const targetData = await res2.json();
  console.log("Target response:", JSON.stringify(targetData, null, 2));
}
run();
