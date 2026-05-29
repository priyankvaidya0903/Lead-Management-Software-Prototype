import { Router, Request, Response } from "express";

const router = Router();

interface TwentyWebhookPayload {
  targetObject: string;
  action: string;
  record: Record<string, any>;
  updatedFields?: string[];
}

router.post("/", async (req: Request, res: Response) => {
  try {
    const payload: TwentyWebhookPayload = req.body;

    const { targetObject, action, record } = payload;

    console.log(`[Twenty Webhook] Received: ${targetObject}.${action}`, {
      recordId: record?.id,
      record,
    });

    // Route to the appropriate handler based on object type + action
    if (targetObject === "lead" && action === "created") {
      await handleLeadCreated(record);
    } else if (targetObject === "task" && action === "created") {
      await handleTaskCreated(record);
    } else {
      console.log(`[Twenty Webhook] Unhandled event: ${targetObject}.${action}`);
    }

    // Always return 200 quickly
    res.status(200).json({ received: true });

  } catch (error) {
    console.error("[Twenty Webhook] Error processing webhook:", error);
    res.status(200).json({ received: true, error: "Processing failed internally" });
  }
});

async function handleLeadCreated(record: Record<string, any>) {
  console.log("[Twenty Webhook] New Lead Created:", {
    id: record.id,
    name: record.name,
    email: record.email?.primaryEmail,
    phone: record.phone?.primaryPhoneNumber,
    createdAt: record.createdAt,
  });
}

async function handleTaskCreated(record: Record<string, any>) {
  console.log("[Twenty Webhook] New Task Created:", {
    id: record.id,
    title: record.title,
    status: record.status,
    dueAt: record.dueAt,
    assigneeId: record.assigneeId,
    createdAt: record.createdAt,
  });
}

export default router;
