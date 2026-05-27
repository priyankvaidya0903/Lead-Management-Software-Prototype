require('dotenv').config({ path: '.env.local' });

async function run() {
  const url = process.env.TWENTY_API_URL.replace('/rest', '/graphql');
  const query = `
    query {
      __type(name: "NoteTargetCreateInput") {
        name
        inputFields {
          name
          type {
            name
            kind
          }
        }
      }
    }
  `;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { 
        Authorization: 'Bearer ' + process.env.TWENTY_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
run();
