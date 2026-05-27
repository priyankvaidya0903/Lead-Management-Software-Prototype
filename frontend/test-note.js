require('dotenv').config({ path: '.env.local' });

async function run() {
  const url = process.env.TWENTY_API_URL + '/notes?limit=1';
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + process.env.TWENTY_API_KEY }
    });
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
run();
