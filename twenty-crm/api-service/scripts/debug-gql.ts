import process from "node:process";
import fs from "node:fs";

const SERVER_URL = process.env.SERVER_URL || "http://server:3000";
const TOKEN = process.env.REAL_API_TOKEN;

async function main() {
  if (!TOKEN) throw new Error("REAL_API_TOKEN is required");

  console.log("Introspecting GraphQL schema...");
  const res = await fetch(`${SERVER_URL}/metadata`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      query: `{
        __type(name: "Mutation") {
          fields(includeDeprecated: true) {
            name
            args {
              name
              type {
                name
                kind
                ofType {
                  name
                  kind
                  ofType {
                    name
                    kind
                  }
                }
              }
            }
          }
        }
      }`,
    }),
  });

  const data = await res.json();
  if (data.errors) {
    console.error("GraphQL Error:", data.errors);
    return;
  }

  const fields = data.data.__type.fields;
  const relMutations = fields.filter((f: any) =>
    f.name.toLowerCase().includes("relation")
  );

  console.log("\nFound relation mutations:");
  console.log(JSON.stringify(relMutations, null, 2));

  // If no relation mutations, look for createOneField
  const fieldMutation = fields.find((f: any) =>
    f.name.toLowerCase().includes("createonefield")
  );
  if (fieldMutation) {
    console.log("\nFound Field mutation:");
    console.log(JSON.stringify(fieldMutation, null, 2));
  }
}

main().catch(console.error);
