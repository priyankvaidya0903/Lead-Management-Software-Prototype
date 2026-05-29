import { Router, Request, Response } from "express";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const TWENTY_API_URL = process.env.TWENTY_API_URL || "http://localhost:3000/rest";
  const TWENTY_API_KEY = process.env.TWENTY_API_KEY || "";

  if (!TWENTY_API_KEY) {
    // Return mock data if no API key is configured
    res.json({
      clinics: [
        { id: "mock-1", name: "Downtown Medical Center", manager: { id: "mock-mgr-1", name: "Alice" } },
        { id: "mock-2", name: "Westside Health Clinic", manager: { id: "mock-mgr-2", name: "Bob" } },
        { id: "mock-3", name: "Sunrise Family Care", manager: null },
      ],
    });
    return;
  }

  try {
    // Fetch clinics and managers in parallel
    const [clinicsRes, managersRes] = await Promise.all([
      fetch(`${TWENTY_API_URL}/clinicss`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TWENTY_API_KEY}`,
        },
      }),
      fetch(`${TWENTY_API_URL}/managerss`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TWENTY_API_KEY}`,
        },
      }),
    ]);

    if (!clinicsRes.ok) {
      const errorText = await clinicsRes.text();
      console.error("Twenty CRM API Error fetching clinics:", errorText);
      res.status(502).json({ error: "Failed to fetch clinics from CRM" });
      return;
    }

    const clinicsData = await clinicsRes.json();
    const rawClinics: any[] = clinicsData?.data?.clinicss ?? [];

    // Build a clinicId → manager map
    const managersByClinicId: Record<string, { id: string; name: string }> = {};
    if (managersRes.ok) {
      const managersData = await managersRes.json();
      const rawManagers: any[] = managersData?.data?.managerss ?? [];
      for (const m of rawManagers) {
        if (m.clinicsId) {
          managersByClinicId[m.clinicsId] = { id: m.id, name: m.name };
        }
      }
    }

    const clinics = rawClinics.map((c: any) => ({
      id: c.id,
      name: c.name,
      manager: managersByClinicId[c.id] ?? null,
    }));

    res.json({ clinics });
  } catch (error) {
    console.error("Error fetching clinics:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

export default router;
