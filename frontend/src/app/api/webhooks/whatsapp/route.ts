import { NextResponse } from "next/server";
import Redis from "ioredis";

// Meta WhatsApp Cloud API credentials
// (These need to be added to .env.local)
const metaAccessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
const metaPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

// Initialize Redis for idempotency
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

export async function POST(req: Request) {
  try {
    // Read from Headers first (as configured in Twenty CRM)
    const headerPhone = req.headers.get("phone");
    const headerStage = req.headers.get("status") || req.headers.get("stage");

    // 1. Parse the incoming webhook payload from Twenty CRM
    let payload: any = {};
    try {
      payload = await req.json();
    } catch (e) {
      console.log("[WhatsApp Webhook] Empty or invalid JSON body. Relying on headers.");
    }

    console.log("[WhatsApp Webhook] Received payload:", payload, "Headers (phone/status):", headerPhone, headerStage);

    // Twenty CRM webhook payloads usually have the record data inside `payload.data`
    const leadData = payload?.data ?? payload;
    
    const stage = headerStage || leadData?.stage;
    const rawName = leadData?.name ?? "there";
    const leadId = leadData?.id || req.headers.get("id");
    
    // Extract the primary phone number
    let phoneNumber = headerPhone || "";

    if (!phoneNumber) {
      const phoneObj = leadData?.phone;
      if (typeof phoneObj === 'object' && phoneObj?.primaryPhoneNumber) {
         const callingCode = phoneObj.primaryPhoneCallingCode || "";
         const number = phoneObj.primaryPhoneNumber;
         phoneNumber = `${callingCode}${number}`;
      } else if (typeof phoneObj === 'string') {
         phoneNumber = phoneObj;
      }
    }

    // 2. Validate the payload
    if (!phoneNumber) {
      console.warn("[WhatsApp Webhook] No phone number found in payload, skipping.");
      return NextResponse.json({ error: "No phone number found" }, { status: 400 });
    }

    // Strip leading '+' or spaces from phone number as Meta requires format without '+'
    const cleanPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');

    if (stage !== "NOT_PICKING_UP") {
      console.log(`[WhatsApp Webhook] Stage is ${stage}, not 'NOT_PICKING_UP'. Skipping.`);
      return NextResponse.json({ message: "Stage ignored" });
    }

    // Idempotency check: prevent sending multiple WhatsApp messages for the same stage
    if (leadId && redis) {
      const idempotencyKey = `whatsapp_sent:${leadId}:${stage}`;
      // SET key with NX (only if it doesn't exist) and EX (expire in 24 hours)
      const lock = await redis.set(idempotencyKey, "sent", "EX", 86400, "NX");
      if (!lock) {
        console.log(`[WhatsApp Webhook] Idempotency lock hit for key: ${idempotencyKey}. Skipping duplicate webhook.`);
        return NextResponse.json({ success: true, message: "Duplicate webhook ignored" });
      }
    }

    if (!metaAccessToken || !metaPhoneNumberId) {
      console.warn("[WhatsApp Webhook] Meta WhatsApp credentials are not set in .env.local. Simulating message.");
      return NextResponse.json({ success: true, simulated: true, message: "Would have sent Meta WhatsApp message" });
    }

    // 3. Send the WhatsApp message via Meta Graph API
    // Using a standard template message
    const templateName = process.env.META_WHATSAPP_TEMPLATE_NAME || "hello_world"; // fallback or from env
    
    const graphApiUrl = `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`;
    
    const requestBody = {
      messaging_product: "whatsapp",
      to: cleanPhoneNumber,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: "en_US"
        },
        // Components can be mapped dynamically if the template takes parameters
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: rawName
              }
            ]
          }
        ]
      }
    };

    const response = await fetch(graphApiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${metaAccessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error("[WhatsApp Webhook] Meta API error:", responseData);
      // Remove the idempotency lock since we failed to send the message
      if (leadId && redis) {
         await redis.del(`whatsapp_sent:${leadId}:${stage}`);
      }
      return NextResponse.json({ error: "Failed to send WhatsApp message via Meta", details: responseData }, { status: 500 });
    }
    
    console.log(`[WhatsApp Webhook] Successfully sent Meta WhatsApp message. ID: ${responseData?.messages?.[0]?.id}`);
    return NextResponse.json({ success: true, messageId: responseData?.messages?.[0]?.id });

  } catch (error) {
    console.error("[WhatsApp Webhook] Error processing webhook:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
