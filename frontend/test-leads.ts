import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

async function run() {
  const url = `${process.env.TWENTY_API_URL}/leadss?limit=5`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.TWENTY_API_KEY}` }
  });
  const data = await res.json();
  const leads = data?.data?.leadss ?? data?.leadss ?? data?.data ?? [];
  leads.forEach((l: any) => {
    console.log(`Lead: ${l.name?.firstName}, Phone:`, l.phone);
  });
}
run();
