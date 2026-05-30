import 'dotenv/config';

async function run() {
  const leadId = "15880163-f306-4d04-9d63-699f246f6cd7";
  const apiUrl = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const apiKey = process.env.TWENTY_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  
  const leadRes = await fetch(`${apiUrl}/leadss/${leadId}`, { headers });
  const leadData = await leadRes.json();
  const lead = leadData.data?.leads || leadData.leads || leadData;
  
  let clinicName = "Not assigned";
  if (lead.clinicId) {
    const clinicRes = await fetch(`${apiUrl}/clinicss/${lead.clinicId}`, { headers });
    if (clinicRes.ok) {
      const clinicData = await clinicRes.json();
      clinicName = clinicData.data?.clinics?.name || clinicData.clinics?.name || "Not assigned";
    }
  }
  
  let managerName = "Pending";
  if (lead.relationshipManagerId) {
    const managerRes = await fetch(`${apiUrl}/managerss/${lead.relationshipManagerId}`, { headers });
    if (managerRes.ok) {
      const managerData = await managerRes.json();
      managerName = managerData.data?.managers?.name || managerData.managers?.name || "Pending";
    }
  }
  
  const result = {
    name: lead.name,
    email: lead.email,
    treatment: lead.treatment,
    clinicName,
    managerName
  };
  
  console.log("Result:", JSON.stringify(result, null, 2));
}

run();
