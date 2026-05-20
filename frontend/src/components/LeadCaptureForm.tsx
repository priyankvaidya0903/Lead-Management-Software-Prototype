"use client";

import { useState, useEffect } from "react";
import { Building2, User, Mail, Phone, ArrowRight, Loader2, CheckCircle2, UserCheck, CalendarDays, ExternalLink } from "lucide-react";

const BOOKING_LINK = "https://calendar.app.google/ZNeBwHTpmscVzm3v7";

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
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");

  // Auto-fetch clinics (with manager info) from the CRM on component mount
  useEffect(() => {
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

  // Derive the assigned manager from the selected clinic
  const selectedClinic = clinics.find((c) => c.id === formData.clinicId) ?? null;
  const assignedManager = selectedClinic?.manager ?? null;

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
          Thank you for choosing us.{" "}
          {assignedManager
            ? <><span className="font-semibold text-white">{assignedManager.name}</span> is your relationship manager and will be in touch soon.</>          
            : "Our relationship manager will be in touch soon."}
        </p>

        {/* Booking CTA */}
        <div className="w-full pt-2">
          <p className="text-zinc-400 text-sm mb-3">Want to lock in a time right now?</p>
          <a
            href={BOOKING_LINK}
            target="_blank"
            rel="noopener noreferrer"
            className="group w-full flex items-center justify-center gap-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white px-6 py-4 rounded-xl font-bold text-lg transition-all shadow-[0_0_30px_rgba(59,130,246,0.4)] hover:shadow-[0_0_50px_rgba(59,130,246,0.6)]"
          >
            <CalendarDays size={22} />
            Book a 30-min Slot
            <ExternalLink size={16} className="opacity-60 group-hover:opacity-100 transition-opacity" />
          </a>
          <p className="text-zinc-500 text-xs mt-2">Opens Google Calendar — pick any available time</p>
        </div>

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

                {/* Auto-assigned manager badge */}
                {assignedManager && (
                  <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 text-sm animate-in fade-in slide-in-from-top-1 duration-300">
                    <UserCheck size={14} className="shrink-0" />
                    <span>
                      Your relationship manager: <span className="font-semibold text-blue-200">{assignedManager.name}</span>
                    </span>
                  </div>
                )}
                {formData.clinicId && !assignedManager && !clinicsLoading && (
                  <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-lg bg-zinc-500/10 border border-zinc-500/20 text-zinc-400 text-sm animate-in fade-in duration-300">
                    <UserCheck size={14} className="shrink-0" />
                    <span>No manager assigned to this clinic yet.</span>
                  </div>
                )}
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
