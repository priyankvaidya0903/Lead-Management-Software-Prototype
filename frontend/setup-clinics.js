const fs = require('fs');

async function setupClinics() {
  const token = 'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjY4ZTUyNDZiLTkyZjMtNGQ3My04ZDA2LThhZGJhMzg3ZjBhYyJ9.eyJzdWIiOiJlZWM1MDRmNC1mNmU0LTRjOWQtODE2ZS03ZGQ1MDIyM2U3MmUiLCJ0eXBlIjoiQVBJX0tFWSIsIndvcmtzcGFjZUlkIjoiZWVjNTA0ZjQtZjZlNC00YzlkLTgxNmUtN2RkNTAyMjNlNzJlIiwiaWF0IjoxNzc5MjcxNDEzLCJleHAiOjQ5MzI4NzE0MTIsImp0aSI6IjVmMTE4ODEwLTc1ODUtNDZjNC1iMjI2LWE4YzZiYzAzMzNhNSJ9.SVriuAVj8JQP1EDvLPUw_lrJ8Zx2rPDgk9ddr047OOanp2w40UwNHj17AkHNKVywchzuzJ634TugtIxhRX04NQ';
  const url = 'http://localhost:3000/rest/clinicss';
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const clinicsToCreate = [
    { name: "Downtown Medical Center", location: "New York, NY" },
    { name: "Westside Health Clinic", location: "Los Angeles, CA" },
    { name: "Sunrise Family Care", location: "Miami, FL" }
  ];

  const results = [];
  
  for (const clinic of clinicsToCreate) {
    try {
      // Create the clinic
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: clinic.name })
      });
      
      const data = await res.json();
      console.log(`Created ${clinic.name}:`, data);
      
      if (data.data && data.data.id) {
        results.push({
          id: data.data.id,
          name: clinic.name,
          location: clinic.location
        });
      }
    } catch (e) {
      console.error(e);
    }
  }

  fs.writeFileSync('clinics-output.json', JSON.stringify(results, null, 2));
}

setupClinics();
