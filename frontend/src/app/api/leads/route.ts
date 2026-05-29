import { NextResponse } from "next/server";

const CRM_API_URL = process.env.CRM_API_URL || "http://localhost:3002";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const response = await fetch(`${CRM_API_URL}/crm-api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[Leads Proxy] CRM API error:", errorText);
      return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("[Leads Proxy] Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
