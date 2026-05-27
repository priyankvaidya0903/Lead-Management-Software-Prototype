require('dotenv').config({ path: '.env.local' });

async function run() {
  const url = process.env.TWENTY_API_URL + '/leadss?limit=2';
  try {
    const res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + process.env.TWENTY_API_KEY }
    });
    const data = await res.json();
    const leads = data?.data?.leadss ?? data?.leadss ?? data?.data ?? [];
    leads.forEach(l => {
      console.log('Lead:', l.name?.firstName, 'Phone:', JSON.stringify(l.phone, null, 2));
    });
  } catch (err) {
    console.error("Fetch error:", err);
  }
}
run();
