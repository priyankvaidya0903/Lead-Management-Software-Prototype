"use client";

import { useState, useEffect } from "react";
import { Building2, User, Mail, Phone, ArrowRight, Loader2, CheckCircle2, Stethoscope } from "lucide-react";

interface Manager {
  id: string;
  name: string;
}

interface Clinic {
  id: string;
  name: string;
  manager: Manager | null;
}

export default function LeadCaptureForm() {
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [clinicsLoading, setClinicsLoading] = useState(true);
  const [clinicsError, setClinicsError] = useState("");

  const [formData, setFormData] = useState({
    clinicId: "",
    name: "",
    email: "",
    phone: "",
    treatment: "",
    source: "Organic",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");

  // Auto-fetch clinics (with manager info) from the CRM on component mount
  useEffect(() => {
    // Capture UTM tracking from URL
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      const utmSource = searchParams.get("utm_source") || searchParams.get("source") || searchParams.get("ref");
      if (utmSource) {
        setFormData((prev) => ({ ...prev, source: utmSource }));
      }
    }

    async function fetchClinics() {
      try {
        const res = await fetch("/api/clinics");
        if (!res.ok) throw new Error("Failed to load clinics");
        const data = await res.json();
        setClinics(data.clinics ?? []);
      } catch (err) {
        setClinicsError("Could not load clinics. Please refresh.");
      } finally {
        setClinicsLoading(false);
      }
    }
    fetchClinics();
  }, []);

  // Derive the selected clinic if needed
  const selectedClinic = clinics.find((c) => c.id === formData.clinicId) ?? null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? (e.target as HTMLInputElement).checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError("");

    try {
      const response = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!response.ok) throw new Error("Failed to submit form");

      setIsSuccess(true);
    } catch (err) {
      setError("Something went wrong. Please try again later.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="w-full max-w-xl mx-auto p-8 rounded-3xl bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl flex flex-col items-center justify-center text-center space-y-5 animate-in fade-in zoom-in duration-500">
        <div className="w-20 h-20 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center">
          <CheckCircle2 size={40} />
        </div>

        <h3 className="text-3xl font-bold text-white tracking-tight">Request Received!</h3>
        <p className="text-zinc-300 text-base leading-relaxed">
          Thank you for choosing us. Our team will be in touch soon.
        </p>

        <button
          onClick={() => setIsSuccess(false)}
          className="px-8 py-2.5 rounded-full bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white text-sm font-medium transition-all border border-white/10"
        >
          Submit Another Request
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto p-8 sm:p-10 rounded-3xl bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl relative overflow-hidden">
      {/* Decorative gradients */}
      <div className="absolute top-0 right-0 -mr-20 -mt-20 w-64 h-64 rounded-full bg-blue-500/20 blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-64 h-64 rounded-full bg-purple-500/20 blur-3xl pointer-events-none" />

      <div className="relative z-10">
        <h2 className="text-3xl font-bold text-white mb-2 tracking-tight">Book an Appointment</h2>
        <p className="text-zinc-300 mb-8">Select a clinic and provide your details. We'll handle the rest.</p>

        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Building2 size={16} /> Select Clinic
            </label>
            {clinicsError ? (
              <p className="text-red-400 text-sm">{clinicsError}</p>
            ) : (
              <>
                <select
                  name="clinicId"
                  required
                  value={formData.clinicId}
                  onChange={handleChange}
                  disabled={clinicsLoading}
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all appearance-none disabled:opacity-60"
                >
                  <option value="" disabled className="bg-zinc-900">
                    {clinicsLoading ? "Loading clinics..." : "Choose a location..."}
                  </option>
                  {clinics.map((clinic) => (
                    <option key={clinic.id} value={clinic.id} className="bg-zinc-900">
                      {clinic.name}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <User size={16} /> Full Name
            </label>
            <input
              type="text"
              name="name"
              required
              placeholder="Jane Doe"
              value={formData.name}
              onChange={handleChange}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <Mail size={16} /> Email Address
              </label>
              <input
                type="email"
                name="email"
                required
                placeholder="jane@example.com"
                value={formData.email}
                onChange={handleChange}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <Phone size={16} /> Phone Number
              </label>
              <input
                type="tel"
                name="phone"
                required
                placeholder="+1 (555) 000-0000"
                value={formData.phone}
                onChange={handleChange}
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-zinc-500 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-zinc-300 flex items-center gap-2">
              <Stethoscope size={16} /> Interested Treatment
            </label>
            <select
              name="treatment"
              required
              value={formData.treatment}
              onChange={handleChange}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all appearance-none"
            >
              <option value="" disabled className="bg-zinc-900">
                Select a treatment...
              </option>
              <option value="General Consultation" className="bg-zinc-900">General Consultation</option>
              <option value="Specialized Treatment" className="bg-zinc-900">Specialized Treatment</option>
              <option value="Follow-up" className="bg-zinc-900">Follow-up</option>
            </select>
          </div>

          <div className="pt-6">
            <button
              type="submit"
              disabled={isSubmitting}
              className="group w-full flex items-center justify-center gap-2 bg-white text-black hover:bg-zinc-200 px-6 py-4 rounded-xl font-bold text-lg transition-all disabled:opacity-70 disabled:cursor-not-allowed shadow-[0_0_40px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_rgba(255,255,255,0.5)]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  Processing...
                </>
              ) : (
                <>
                  Submit Request <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
