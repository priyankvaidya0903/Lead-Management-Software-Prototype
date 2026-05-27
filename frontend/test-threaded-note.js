require('dotenv').config({ path: '.env.local' });
const { createLeadNote } = require('./src/lib/twentyCrmClient.ts');
// wait, we can't require TS file directly in Node easily without ts-node.
// I will just copy the logic here.

async function run() {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;
  const leadId = "5ab46582-a246-4af9-98b6-2088db90150b";
  const text = "Testing threading...";

  try {
    let transcriptNote = null;
    const targetRes = await fetch(`${apiUrl}/noteTargets?filter=targetLeadsId[eq]:${leadId}&limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
    });
    
    if (targetRes.ok) {
      const targetData = await targetRes.json();
      console.log("Targets fetched:", targetData);
      const targets = targetData?.data?.noteTargets ?? targetData?.noteTargets ?? targetData?.data ?? [];
      
      const notePromises = targets.map((target) => {
        if (target.noteId) {
          return fetch(`${apiUrl}/notes/${target.noteId}`, {
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
          }).then(r => r.ok ? r.json() : null);
        }
        return Promise.resolve(null);
      });

      const noteResults = await Promise.all(notePromises);
      
      for (const noteData of noteResults) {
        if (!noteData) continue;
        const note = noteData?.data?.note ?? noteData?.note ?? noteData?.data ?? noteData;
        if (note && note.title === "📱 WhatsApp Chat Transcript") {
          transcriptNote = note;
          break;
        }
      }
    } else {
        console.log("Failed to fetch targets:", await targetRes.text());
    }

    const timestamp = new Date().toLocaleString();
    const formattedMessage = `[${timestamp}] 🟢 IN: ${text}`;

    if (transcriptNote) {
      console.log("Found existing note:", transcriptNote.id);
      let blocks = [];
      try {
        if (typeof transcriptNote.bodyV2?.blocknote === 'string') {
          blocks = JSON.parse(transcriptNote.bodyV2.blocknote);
        } else if (Array.isArray(transcriptNote.bodyV2?.blocknote)) {
          blocks = transcriptNote.bodyV2.blocknote;
        }
      } catch (e) {
        console.warn("Could not parse existing blocknote");
      }
      
      blocks.push({ type: "paragraph", content: formattedMessage });

      const patchRes = await fetch(`${apiUrl}/notes/${transcriptNote.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyV2: {
            blocknote: JSON.stringify(blocks)
          }
        })
      });
      console.log("PATCH response:", await patchRes.text());
    } else {
      console.log("Creating new note...");
      const response = await fetch(`${apiUrl}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "📱 WhatsApp Chat Transcript",
          bodyV2: {
            blocknote: JSON.stringify([{ type: "paragraph", content: formattedMessage }])
          }
        })
      });
      const noteData = await response.json();
      console.log("Create note response:", JSON.stringify(noteData));
      
      const noteId = noteData?.data?.createNote?.id ?? noteData?.data?.notes?.id ?? noteData?.data?.id ?? noteData?.id;
      if (noteId) {
        console.log("Creating NoteTarget for Note ID:", noteId);
        const ntRes = await fetch(`${apiUrl}/noteTargets`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            noteId: noteId,
            targetLeadsId: leadId
          })
        });
        console.log("NoteTarget response:", await ntRes.text());
      }
    }
  } catch (e) {
    console.error("Error:", e);
  }
}
run();
