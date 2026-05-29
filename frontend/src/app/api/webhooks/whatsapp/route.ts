import { NextResponse } from "next/server";

const CRM_API_URL = process.env.CRM_API_URL || "http://localhost:3002";

// GET handler for Meta webhook verification
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const queryString = url.search; // includes the leading '?'

    const response = await fetch(`${CRM_API_URL}/crm-api/webhooks/whatsapp${queryString}`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });

    const text = await response.text();
    return new NextResponse(text, { status: response.status });
  } catch (error) {
    console.error("[WhatsApp Proxy] GET Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// POST handler for incoming messages and Twenty CRM webhooks
export async function POST(req: Request) {
  try {
    // Read the raw body
    let body: any = {};
    try {
      body = await req.json();
    } catch (e) {
      // Empty body is fine — rely on headers
    }

    // Forward relevant headers from the original request
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    
    // Forward Twenty CRM custom headers
    const phoneHeader = req.headers.get("phone");
    const statusHeader = req.headers.get("status");
    const stageHeader = req.headers.get("stage");
    const idHeader = req.headers.get("id");
    
    if (phoneHeader) headers["phone"] = phoneHeader;
    if (statusHeader) headers["status"] = statusHeader;
    if (stageHeader) headers["stage"] = stageHeader;
    if (idHeader) headers["id"] = idHeader;

    const response = await fetch(`${CRM_API_URL}/crm-api/webhooks/whatsapp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error("[WhatsApp Proxy] POST Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
