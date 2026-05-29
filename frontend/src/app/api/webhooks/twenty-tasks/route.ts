import { NextResponse } from "next/server";

const CRM_API_URL = process.env.CRM_API_URL || "http://localhost:3002";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const response = await fetch(`${CRM_API_URL}/crm-api/webhooks/twenty-tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[Twenty Tasks Proxy] Error:", error);
    // Return 200 even on errors to prevent Twenty from retrying
    return NextResponse.json({ received: true, error: "Processing failed internally" }, { status: 200 });
  }
}
