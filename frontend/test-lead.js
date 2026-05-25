const email = "test" + Math.random() + "@test.com";

async function run() {
  console.log("Creating new lead...");
  const res1 = await fetch("http://localhost:3001/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clinicId: "123", name: "Test User", email, phone: "1234567890" })
  });
  console.log("Res 1:", await res1.json());

  console.log("Waiting 5 seconds for webhook to process...");
  await new Promise(r => setTimeout(r, 5000));

  console.log("Creating duplicate lead...");
  const res2 = await fetch("http://localhost:3001/api/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clinicId: "123", name: "Test User", email, phone: "1234567890" })
  });
  const json2 = await res2.json();
  console.log("Res 2:", json2);
}
run();
