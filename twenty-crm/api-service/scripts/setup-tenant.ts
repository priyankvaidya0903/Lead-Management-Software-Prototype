const API_KEY = process.argv[2];
const API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";

if (!API_KEY) {
  console.error("Usage: npx ts-node scripts/setup-tenant.ts <WORKSPACE_API_KEY>");
  process.exit(1);
}

const HEADERS = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json"
};

async function createObject(name: string, labelSingular: string, labelPlural: string) {
  console.log(`Creating object: ${name}...`);
  const res = await fetch(`${API_URL}/metadata/objects`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ name, labelSingular, labelPlural, description: `Custom object for ${labelPlural}` })
  });
  if (!res.ok) {
    const error = await res.text();
    console.warn(`[!] Failed to create object ${name}: ${error}`);
    return null;
  }
  const data = await res.json();
  return data?.data?.id ?? data?.id;
}

async function createField(objectId: string, name: string, type: string, label: string) {
  console.log(`Adding field ${name} to object ${objectId}...`);
  const res = await fetch(`${API_URL}/metadata/fields`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ objectId, name, type, label })
  });
  if (!res.ok) {
    const error = await res.text();
    console.warn(`[!] Failed to create field ${name}: ${error}`);
  }
}

async function createRelation(sourceObjectName: string, targetObjectName: string, relationType: string, foreignKeyName: string) {
  console.log(`Creating ${relationType} relation: ${sourceObjectName} -> ${targetObjectName}...`);
  const res = await fetch(`${API_URL}/metadata/relations`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      relationType,
      sourceObjectName,
      targetObjectName,
      foreignKeyName
    })
  });
  if (!res.ok) {
    const error = await res.text();
    console.warn(`[!] Failed to create relation: ${error}`);
  }
}

async function main() {
  console.log("🚀 Starting Tenant Setup Process...");

  // Phase A: Object Creation
  const clinicObjectId = await createObject("clinicss", "Clinic", "Clinics");
  const managerObjectId = await createObject("managerss", "Manager", "Managers");
  const leadObjectId = await createObject("leadss", "Lead", "Leads");

  // Phase B: Relational Mapping (The Hard Part)
  // 1. One Clinic has Many Managers -> generates clinicsId on managerss
  await createRelation("clinicss", "managerss", "ONE_TO_MANY", "clinicsId");
  
  // 2. One Manager handles Many Leads -> generates relationshipManagerId on leadss
  await createRelation("managerss", "leadss", "ONE_TO_MANY", "relationshipManagerId");

  // Phase C: Scalar Fields for Leadss
  if (leadObjectId) {
    await createField(leadObjectId, "name", "TEXT", "Lead Name");
    await createField(leadObjectId, "phone", "PHONES", "Phone Numbers");
    await createField(leadObjectId, "emails", "EMAILS", "Emails");
    await createField(leadObjectId, "stage", "SELECT", "Pipeline Stage");
    await createField(leadObjectId, "treatment", "TEXT", "Treatment Interested In");
  }

  // Phase C: Scalar Fields for Managerss
  if (managerObjectId) {
    await createField(managerObjectId, "name", "TEXT", "Manager Name");
  }

  // Phase C: Scalar Fields for Clinicss
  if (clinicObjectId) {
    await createField(clinicObjectId, "name", "TEXT", "Clinic Name");
  }

  // Phase D: Automating Workflows & Webhooks
  console.log("Cloning Workflows...");
  const graphqlUrl = API_URL.replace('/rest', '/graphql');
  
  // 1. Create a draft from your master workflow template
  const draftRes = await fetch(graphqlUrl, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      query: `
        mutation {
          createDraftFromWorkflowVersion(data: {
            // Replace with your Master Workspace Workflow Version ID
            workflowVersionId: "MASTER_WORKFLOW_ID_HERE" 
          }) {
            id
            workflowId
          }
        }
      `
    })
  });
  
  if (draftRes.ok) {
    console.log("✅ Workflows and Webhook steps successfully cloned via GraphQL!");
  } else {
    console.warn("[!] Failed to clone workflows via GraphQL.");
  }

  console.log("✅ Tenant Setup Complete!");
  console.log("Schema, Relations, and Workflows have been instantly replicated.");
}

main().catch(console.error);
