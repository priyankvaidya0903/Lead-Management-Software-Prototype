import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { clinicId, name, email, phone } = body;

    // Validate the incoming data
    if (!name || !email || !phone) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // In a production environment, you would retrieve these from process.env
    // e.g. process.env.TWENTY_API_URL and process.env.TWENTY_API_KEY
    const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
    const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";

    if (!TWENTY_API_KEY) {
      console.warn("TWENTY_API_KEY is not set. Simulating a successful request for demonstration purposes.");
      console.log("Captured Lead:", { clinicId, name, email, phone, followup });
      
      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return NextResponse.json({ success: true, message: "Lead captured (Simulated)" });
    }

    // Example payload assuming you created a custom 'leads' object in Twenty CRM
    // If you used the 'Email' and 'Phone' field types in Twenty CRM, they expect objects.
    const crmPayload: any = {
      name: name,
      email: {
        primaryEmail: email
      },
      phone: {
        primaryPhoneNumber: phone,
        primaryPhoneCountryCode: "US",
        primaryPhoneCallingCode: "+1"
      }
      // Twenty CRM is rejecting clinicId because the API identifier doesn't perfectly match what is set in the CRM
      // clinicId: clinicId
    };

    const response = await fetch(`${TWENTY_API_URL}/leadss`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TWENTY_API_KEY}`
      },
      body: JSON.stringify(crmPayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Twenty CRM API Error:", errorText);
      throw new Error("Failed to sync lead to CRM");
    }

    return NextResponse.json({ success: true });
    
  } catch (error) {
    console.error("Lead capture error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
