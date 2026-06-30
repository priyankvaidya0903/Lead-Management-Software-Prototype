import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { getWorkspaceMemberClinic } from "../lib/workspaceCache.js";

/**
 * Middleware to intercept GraphQL requests BEFORE they reach the proxy.
 * Injects a Row-Level Security filter for specific users.
 */
export const graphqlRlsInterceptor = async (req: Request, res: Response, next: NextFunction) => {
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
        if (userId) {
          const assignedClinicId = await getWorkspaceMemberClinic(userId);
          if (assignedClinicId) {
            console.log(`[RLS Proxy] Enforcing clinic filter for user ${userId} -> Clinic: ${assignedClinicId}`);

            // Ensure variables object exists
            req.body.variables = req.body.variables || {};
            req.body.variables.filter = req.body.variables.filter || {};

            // Inject the clinic filter! 
            // Twenty GraphQL syntax uses { clinicId: { in: ["..."] } } for multiple matching
            req.body.variables.filter = {
              ...req.body.variables.filter,
              clinicId: { in: [assignedClinicId] }
            };
          } else {
             console.log(`[RLS Proxy] User ${userId} has no clinic assigned. Granting full access.`);
          }
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
