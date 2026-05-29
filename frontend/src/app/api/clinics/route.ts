import { NextResponse } from "next/server";

const CRM_API_URL = process.env.CRM_API_URL || "http://localhost:3002";

export async function GET() {
  try {
    const response = await fetch(`${CRM_API_URL}/crm-api/clinics`, {
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Clinics Proxy] CRM API error:", errorText);
      return NextResponse.json({ error: "Failed to fetch clinics" }, { status: 502 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[Clinics Proxy] Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
