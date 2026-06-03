export async function sendWhatsAppMessage(to, messageBody) {
    const metaAccessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    const metaPhoneNumberId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    if (!metaAccessToken || !metaPhoneNumberId) {
        console.warn("[WhatsApp Bot] Missing Meta credentials. Simulating send:", JSON.stringify(messageBody));
        return true;
    }
    const graphApiUrl = `https://graph.facebook.com/v18.0/${metaPhoneNumberId}/messages`;
    const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        ...messageBody
    };
    const response = await fetch(graphApiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${metaAccessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    const responseData = await response.json();
    if (!response.ok) {
        console.error("[WhatsApp Bot] Error sending message:", responseData);
        return false;
    }
    return true;
}
export async function sendWhatsAppText(to, text) {
    return sendWhatsAppMessage(to, {
        type: "text",
        text: { body: text }
    });
}
export async function sendWhatsAppInteractiveList(to, header, body, buttonText, sections) {
    return sendWhatsAppMessage(to, {
        type: "interactive",
        interactive: {
            type: "list",
            header: {
                type: "text",
                text: header
            },
            body: {
                text: body
            },
            action: {
                button: buttonText,
                sections: sections
            }
        }
    });
}
export async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
    return sendWhatsAppMessage(to, {
        type: "interactive",
        interactive: {
            type: "button",
            body: {
                text: bodyText
            },
            action: {
                buttons: buttons.map(b => ({
                    type: "reply",
                    reply: {
                        id: b.id,
                        title: b.title
                    }
                }))
            }
        }
    });
}
