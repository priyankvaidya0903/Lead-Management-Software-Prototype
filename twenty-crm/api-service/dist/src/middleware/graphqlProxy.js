import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import jwt from "jsonwebtoken";
// Mapping of Restricted User IDs to Allowed Clinic IDs (can be one or multiple)
const CLINIC_ACCESS_MAP = {
    // priyankvaidya09@gmail.com
    "c1df67a2-d6df-4470-98be-8f49f7b630b3": [
        "e2e061fb-9169-4c07-b911-32ac926ce25d"
        // Add more clinic UUIDs here if they manage multiple!
    ],
};
/**
 * Middleware to intercept GraphQL requests BEFORE they reach the proxy.
 * Injects a Row-Level Security filter for specific users.
 */
export const graphqlRlsInterceptor = (req, res, next) => {
    // Only process POST requests with a JSON body
    if (req.method !== "POST" || !req.body) {
        return next();
    }
    console.log(`[RLS Proxy] Received request: ${req.method} ${req.originalUrl}`);
    // Intercept the 'FindManyLeadss' query
    if (req.body.operationName === "FindManyLeadss") {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            const token = authHeader.split(" ")[1];
            try {
                // Decode the JWT (no signature check needed here since Twenty core will do it)
                const decoded = jwt.decode(token);
                if (!decoded)
                    return next();
                console.log(`[RLS Proxy] Decoded JWT:`, decoded);
                // Twenty usually stores user ID in `sub` or `id` or `userId`
                const userId = decoded.sub || decoded.id || decoded.userId;
                // If this user is restricted to a specific clinic
                if (userId && CLINIC_ACCESS_MAP[userId]) {
                    const allowedClinicIds = CLINIC_ACCESS_MAP[userId];
                    console.log(`[RLS Proxy] Enforcing clinic filter for user ${userId} -> Clinics: ${allowedClinicIds.join(", ")}`);
                    // Ensure variables object exists
                    req.body.variables = req.body.variables || {};
                    req.body.variables.filter = req.body.variables.filter || {};
                    // Inject the clinic filter! 
                    // Twenty GraphQL syntax uses { clinicId: { in: ["..."] } } for multiple matching
                    req.body.variables.filter = {
                        ...req.body.variables.filter,
                        clinicId: { in: allowedClinicIds }
                    };
                }
            }
            catch (err) {
                console.error("[RLS Proxy] Error decoding JWT:", err);
            }
        }
    }
    next();
};
/**
 * The actual Proxy Middleware.
 * Forwards the modified request to Twenty Core.
 */
export const twentyProxy = createProxyMiddleware({
    // Target points to Twenty CRM backend
    target: process.env.TWENTY_API_URL?.replace("/rest", "") || "http://localhost:3000",
    changeOrigin: true,
    pathRewrite: {
        '^/': '/graphql', // Express strips '/graphql' from the URL, so we must add it back before forwarding!
    },
    on: {
        // Crucial: Re-serializes the req.body (which we modified) back into a stream
        proxyReq: fixRequestBody,
        proxyRes: (proxyRes) => {
            // Strip Twenty's CORS headers to prevent "duplicate header" CORS errors in the browser
            delete proxyRes.headers['access-control-allow-origin'];
            delete proxyRes.headers['access-control-allow-credentials'];
            delete proxyRes.headers['access-control-allow-methods'];
            delete proxyRes.headers['access-control-allow-headers'];
        },
    },
});
