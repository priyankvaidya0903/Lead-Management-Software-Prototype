require('dotenv').config({ path: '.env.local' });

async function run() {
  const url = process.env.TWENTY_API_URL.replace('/rest', '/metadata/objects/noteTargets');
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + process.env.TWENTY_API_KEY }
    });
    const data = await res.json();
    console.log(data.fields.map(f => f.name).join(", "));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
run();
