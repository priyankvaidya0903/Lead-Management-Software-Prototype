import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const CLINIC_ACCESS_MAP: Record<string, string[]> = {
  // Ashima Katyal -> SDA Clinic
  "019acef8-e918-47f0-ac0f-8b70fcf96faf": [
    "f5a563b6-1ba4-42a3-9bf6-f9aa0e4d8699"
  ],
  // Shweta -> Khan Market Clinic
  "aa591fbc-eccf-4102-b6d4-cc15f0a128a6": [
    "e2e061fb-9169-4c07-b911-32ac926ce25d"
  ]
};

/**
 * Middleware to intercept GraphQL requests BEFORE they reach the proxy.
 * Injects a Row-Level Security filter for specific users.
 */
export const graphqlRlsInterceptor = (req: Request, res: Response, next: NextFunction) => {
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
        const decoded = jwt.decode(token) as any;
        if (!decoded) return next();
        
        console.log(`[RLS Proxy] Decoded JWT:`, decoded);

        // Twenty usually stores the member ID we see in the UI as workspaceMemberId
        const userId = decoded.workspaceMemberId || decoded.sub || decoded.id || decoded.userId;

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
      } catch (err) {
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
