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

    const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
    const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";

    if (!TWENTY_API_KEY) {
      console.warn("TWENTY_API_KEY is not set. Simulating a successful request for demonstration purposes.");
      console.log("Captured Lead:", { clinicId, name, email, phone });
      await new Promise(resolve => setTimeout(resolve, 1000));
      return NextResponse.json({ success: true, message: "Lead captured (Simulated)" });
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TWENTY_API_KEY}`,
    };

    // Auto-resolve the relationship manager for the selected clinic
    let relationshipManagerId: string | null = null;
    if (clinicId) {
      try {
        const mgrsRes = await fetch(
          `${TWENTY_API_URL}/managerss?filter=clinicsId[eq]:${clinicId}`,
          { headers, cache: "no-store" }
        );
        if (mgrsRes.ok) {
          const mgrsData = await mgrsRes.json();
          const managers: any[] = mgrsData?.data?.managerss ?? [];
          if (managers.length > 0) {
            relationshipManagerId = managers[0].id;
          }
        }
      } catch (err) {
        console.warn("Could not resolve manager for clinic, proceeding without:", err);
      }
    }

    // Build CRM payload
    const crmPayload: any = {
      name,
      email: { primaryEmail: email },
      phone: { primaryPhoneNumber: phone },
    };

    if (clinicId) {
      crmPayload.clinicId = clinicId;
    }
    if (relationshipManagerId) {
      crmPayload.relationshipManagerId = relationshipManagerId;
    }

    const response = await fetch(`${TWENTY_API_URL}/leadss`, {
      method: "POST",
      headers,
      body: JSON.stringify(crmPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Twenty CRM API Error:", errorText);
      throw new Error("Failed to sync lead to CRM");
    }

    return NextResponse.json({ success: true, relationshipManagerId });

  } catch (error) {
    console.error("Lead capture error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
