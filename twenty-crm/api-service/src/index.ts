import "dotenv/config";
import express from "express";
import cors from "cors";

import clinicsRouter from "./routes/clinics.js";
import leadsRouter from "./routes/leads.js";
import whatsappRouter from "./routes/webhooks/whatsapp.js";
import twentyTasksRouter from "./routes/webhooks/twentyTasks.js";
import metaLeadsRouter from "./routes/webhooks/metaLeads.js";
import wpContactRouter from "./routes/webhooks/wpContact.js";
import fieldChangesRouter from "./routes/webhooks/fieldChanges.js";
import migrationRouter from "./routes/migration.js";

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors({
  origin: true, // Allow all origins for the proxy
  credentials: true,
  allowedHeaders: "*", // Allow all headers
}));
app.use(express.json());

import { graphqlRlsInterceptor, twentyProxy } from "./middleware/graphqlProxy.js";
app.use("/graphql", graphqlRlsInterceptor, twentyProxy);
// Health check
app.get("/crm-api/health", (_req, res) => {
  res.json({ status: "ok", service: "twenty-crm-api-service" });
});

// Mount routes
app.use("/crm-api/clinics", clinicsRouter);
app.use("/crm-api/leads", leadsRouter);
app.use("/crm-api/webhooks/whatsapp", whatsappRouter);
app.use("/crm-api/webhooks/twenty-tasks", twentyTasksRouter);
app.use("/crm-api/webhooks/meta-leads", metaLeadsRouter);
app.use("/crm-api/webhooks/wp-cf7", wpContactRouter);
app.use("/crm-api/webhooks/field-changes", fieldChangesRouter);
app.use("/crm-api/migration", migrationRouter);

// Serve static files (booking panel)
app.use("/public", express.static("public"));

app.listen(PORT, () => {
  console.log(`[CRM API Service] Running on http://localhost:${PORT}`);
  console.log(`[CRM API Service] Twenty CRM URL: ${process.env.TWENTY_API_URL || "http://localhost:3000/rest"}`);
});
