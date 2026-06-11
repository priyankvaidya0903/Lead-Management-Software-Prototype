import { Router, Request, Response } from "express";
import Redis from "ioredis";
import {
  findLeadByPhone, createLeadNote, createEscalationTask, updateLeadStage, updateLeadFields, getClinicsList, getManagersForClinic
} from "../../lib/twentyCrmClient.js";
import { getNextManagerIndex } from "../../lib/roundRobin.js";
import {
  sendWhatsAppText, sendWhatsAppInteractiveList, sendWhatsAppInteractiveButtons
} from "../../lib/whatsapp.js";

const router = Router();

// Meta WhatsApp Cloud API credentials
const metaAccessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
const metaPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

// Initialize Redis
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN || "my_super_secret_token_123";

  if (mode === "subscribe" && token === verifyToken) {
    console.log("[WhatsApp Webhook] Verification successful!");
    res.status(200).send(challenge);
  } else {
    console.warn("[WhatsApp Webhook] Verification failed. Token mismatch.");
    res.status(403).send("Forbidden");
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const headerPhone = req.headers["phone"] as string | undefined;
    const headerStage = (req.headers["status"] || req.headers["stage"]) as string | undefined;
    const payload: any = req.body || {};

    // ─── INCOMING MESSAGE HANDLING (From Meta) ──────────────────────────────────
    if (payload?.object === "whatsapp_business_account") {
      const entry = payload.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (value?.messages && value.messages.length > 0) {
        const message = value.messages[0];
        const fromNumber = message.from;

        // Extract text depending on message type (text vs interactive reply)
        let messageText = "";
        let interactiveId = "";

        if (message.type === "text") {
          messageText = message.text?.body || "";
        } else if (message.type === "interactive") {
          if (message.interactive?.type === "button_reply") {
            messageText = message.interactive.button_reply.title;
            interactiveId = message.interactive.button_reply.id;
          } else if (message.interactive?.type === "list_reply") {
            messageText = message.interactive.list_reply.title;
            interactiveId = message.interactive.list_reply.id;
          }
        }

        console.log(`[WhatsApp Webhook] Received incoming message from ${fromNumber}: "${messageText}"`);

        const lead = await findLeadByPhone(fromNumber);
        if (lead) {
          console.log(`[WhatsApp Webhook] Found matching lead ${lead.id}. Logging note...`);
          await createLeadNote(lead.id, `User said: ${messageText}`);

          // ─── STATEFUL CHATBOT LOGIC ───
          if (redis) {
            const botStateKey = `bot_state:${lead.id}`;
            const currentState = await redis.get(botStateKey);

            if (currentState) {
              console.log(`[WhatsApp Bot] Processing state ${currentState} for lead ${lead.id}`);

              if (currentState === "AWAITING_REPLY") {
                await sendWhatsAppText(fromNumber, "Thanks! To start, what is your full name?");
                await redis.set(botStateKey, "AWAITING_NAME", "EX", 86400);
                return res.json({ success: true, message: "Handled AWAITING_REPLY" });
              }

              if (currentState === "AWAITING_NAME") {
                await updateLeadFields(lead.id, { name: messageText });
                await sendWhatsAppText(fromNumber, "Great! What is your email address?");
                await redis.set(botStateKey, "AWAITING_EMAIL", "EX", 86400);
                return res.json({ success: true, message: "Handled AWAITING_NAME" });
              }

              if (currentState === "AWAITING_EMAIL") {
                // Twenty CRM expects the email field to be an object for PATCH requests
                await updateLeadFields(lead.id, { emails: [{ primaryEmail: messageText, emailsLabel: "Work" }] });

                // Fetch clinics to build interactive list
                const clinics = await getClinicsList();
                if (clinics.length > 0) {
                  const rows = clinics.map(c => ({ id: c.id, title: c.name.substring(0, 24) }));
                  await sendWhatsAppInteractiveList(fromNumber, "Clinic Location", "Which clinic are you interested in?", "View Clinics", [
                    { title: "Locations", rows }
                  ]);
                } else {
                  await sendWhatsAppText(fromNumber, "Which clinic location are you interested in?");
                }

                await redis.set(botStateKey, "AWAITING_CLINIC", "EX", 86400);
                return res.json({ success: true, message: "Handled AWAITING_EMAIL" });
              }

              if (currentState === "AWAITING_CLINIC") {
                // If they used the interactive list, we got the clinic ID in interactiveId
                const clinicId = interactiveId || messageText; // fallback to text if they didn't use list

                // If interactiveId is present, we know it's a valid ID. Otherwise, it might just be text, which Twenty CRM might reject.
                // We'll try to update it anyway. In a production app, we'd do a fuzzy search if interactiveId is missing.
                if (interactiveId) {
                  let managerIdToAssign = null;
                  try {
                    const managers = await getManagersForClinic(interactiveId);
                    if (managers.length > 0) {
                      const managerIndex = await getNextManagerIndex(interactiveId, managers.length);
                      managerIdToAssign = managers[managerIndex].id;
                      console.log(`[WhatsApp Bot] Round-robin assigned manager ${managerIdToAssign} to lead ${lead.id}`);
                    }
                  } catch (e) {
                    console.error("[WhatsApp Bot] Failed to assign manager", e);
                  }

                  await updateLeadFields(lead.id, {
                    clinicId: interactiveId,
                    ...(managerIdToAssign && { relationshipManagerId: managerIdToAssign })
                  });
                }

                const treatments = [
                  { id: "GENERAL_CONSULTATION", title: "General Consultation" },
                  { id: "SPECIALIZED_TREATMENT", title: "Specialized Treatment" },
                  { id: "FOLLOW_UP", title: "Follow up" }
                ];

                await sendWhatsAppInteractiveList(fromNumber, "Treatments", "Lastly, what treatment are you looking for?", "View Treatments", [
                  { title: "Available Treatments", rows: treatments }
                ]);

                await redis.set(botStateKey, "AWAITING_TREATMENT", "EX", 86400);
                return res.json({ success: true, message: "Handled AWAITING_CLINIC" });
              }

              if (currentState === "AWAITING_TREATMENT") {
                let treatmentVal = "GENERAL_CONSULTATION";
                if (interactiveId) {
                  treatmentVal = interactiveId; // ACNE, HAIR_LOSS, etc.
                } else {
                  treatmentVal = messageText.toUpperCase().replace(/\s+/g, "_");
                }

                await updateLeadFields(lead.id, { treatment: treatmentVal });
                await updateLeadStage(lead.id, "REQUIREMENTS_GATHERED");

                await sendWhatsAppText(fromNumber, "Thank you! All set. Our manager will reach out to you shortly.");
                await redis.del(botStateKey);
                return res.json({ success: true, message: "Handled AWAITING_TREATMENT (Completed)" });
              }
            }
          }
          // ─── END STATEFUL CHATBOT LOGIC ───

          // Normal Stage Update
          await updateLeadStage(lead.id, "WHATSAPP_MESSAGE_INCOMED");

          // Escalation Check
          const textLower = messageText.toLowerCase();
          const escalationKeywords = ["human", "manager", "talk to", "escalate", "call me"];
          if (escalationKeywords.some(keyword => textLower.includes(keyword))) {
            console.log(`[WhatsApp Webhook] Escalation keyword detected! Creating Task for lead ${lead.id}...`);
            await createEscalationTask(lead.id, lead.relationshipManagerId || "", messageText);
          }
        } else {
          console.log(`[WhatsApp Webhook] No matching lead found for phone number ${fromNumber}.`);
        }

        res.json({ success: true, message: "Incoming message processed" });
        return;
      }

      if (value?.statuses) {
        console.log("[WhatsApp Webhook] Received status update from Meta:", value.statuses[0].status);
        res.json({ success: true, message: "Status update processed" });
        return;
      }

      res.json({ success: true, message: "Webhook received but not actionable" });
      return;
    }
    // ────────────────────────────────────────────────────────────────────────────

    // OUTBOUND MESSAGES FROM TWENTY CRM
    const leadData = payload?.data ?? payload;
    const stage = headerStage || leadData?.stage;
    const leadId = leadData?.id || req.headers["id"];

    console.log(`[WhatsApp Webhook] Received webhook from Twenty CRM! Lead ID: ${leadId}, Stage: ${stage}`);
    console.log(`[WhatsApp Webhook] Full Payload:`, JSON.stringify(payload, null, 2));
    console.log(`[WhatsApp Webhook] Headers:`, JSON.stringify(req.headers, null, 2));

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

    if (!phoneNumber) {
      console.error(`[WhatsApp Webhook] Error: No phone number found for lead ${leadId}`);
      res.status(400).json({ error: "No phone number found" });
      return;
    }

    let cleanPhoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    if (cleanPhoneNumber.length === 10) {
      cleanPhoneNumber = `91${cleanPhoneNumber}`;
    }
    console.log(`[WhatsApp Webhook] Parsed phone number: ${phoneNumber} -> ${cleanPhoneNumber}`);

    // ─── STAGE: REQ BY WHATSAPP ─────────────────────────────────────────────────
    if (stage === "REQ_BY_WHATSAPP") {
      if (leadId && redis) {
        const botStateKey = `bot_state:${leadId}`;
        const idempotencyKey = `whatsapp_sent:${leadId}:${stage}`;

        // *** IDEMPOTENCY DISABLED FOR TESTING ***
        // const lock = await redis.set(idempotencyKey, "sent", "EX", 86400, "NX");
        // if (!lock) {
        //   console.log(`[WhatsApp Webhook] Idempotency lock hit for REQ_BY_WHATSAPP. Skipping.`);
        //   return res.json({ success: true, message: "Duplicate webhook ignored" });
        // }

        if (!metaAccessToken || !metaPhoneNumberId) {
          console.warn("[WhatsApp Webhook] Meta credentials not set. Simulating bot initialization.");
          await redis.set(botStateKey, "AWAITING_REPLY", "EX", 86400);
          return res.json({ success: true, simulated: true });
        }

        const templateName = process.env.META_WHATSAPP_TEMPLATE_NAME || "hello_world";
        const graphApiUrl = `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`;

        const requestBody = {
          messaging_product: "whatsapp",
          to: cleanPhoneNumber,
          type: "template",
          template: { name: templateName, language: { code: process.env.META_WHATSAPP_TEMPLATE_LANG || "en" } }
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
          await redis.del(idempotencyKey);
          return res.status(500).json({ error: "Failed to send Meta message", details: responseData });
        }

        // Initialize Bot State
        console.log(`[WhatsApp Bot] Initialized AWAITING_REPLY state for lead: ${leadId}`);
        await redis.set(botStateKey, "AWAITING_REPLY", "EX", 86400);

        return res.json({ success: true, messageId: responseData?.messages?.[0]?.id });
      }
    }

    // ─── STAGE: NOT PICKING UP ──────────────────────────────────────────────────
    if (stage === "NOT_PICKING_UP") {
      if (leadId && redis) {
        // *** IDEMPOTENCY DISABLED FOR TESTING ***
        // const idempotencyKey = `whatsapp_sent:${leadId}:${stage}`;
        // const lock = await redis.set(idempotencyKey, "sent", "EX", 86400, "NX");
        // if (!lock) {
        //   return res.json({ success: true, message: "Duplicate webhook ignored" });
        // }
      }

      if (!metaAccessToken || !metaPhoneNumberId) {
        console.warn("[WhatsApp Webhook] Meta credentials not set. Simulating NOT_PICKING_UP message.");
        return res.json({ success: true, simulated: true });
      }

      const templateName = process.env.META_WHATSAPP_TEMPLATE_NAME || "hello_world";
      const graphApiUrl = `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`;

      const requestBody = {
        messaging_product: "whatsapp",
        to: cleanPhoneNumber,
        type: "template",
        template: { name: templateName, language: { code: process.env.META_WHATSAPP_TEMPLATE_LANG || "en" } }
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
        console.error(`[WhatsApp Webhook] Failed to send NOT_PICKING_UP message. Meta API responded with:`, JSON.stringify(responseData, null, 2));
        if (leadId && redis) await redis.del(`whatsapp_sent:${leadId}:${stage}`);
        return res.status(500).json({ error: "Failed to send Meta message", details: responseData });
      }

      console.log(`[WhatsApp Webhook] Successfully sent NOT_PICKING_UP Meta message! Message ID:`, responseData?.messages?.[0]?.id);
      return res.json({ success: true, messageId: responseData?.messages?.[0]?.id });
    }

    console.log(`[WhatsApp Webhook] Webhook ignored. Stage "${stage}" is not configured for WhatsApp triggers.`);
    res.json({ message: "Stage ignored" });

  } catch (error) {
    console.error("[WhatsApp Webhook] Error processing webhook:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
