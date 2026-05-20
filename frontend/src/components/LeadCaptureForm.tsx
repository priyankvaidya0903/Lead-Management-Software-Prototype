"use client";

import { useState } from "react";
import { Building2, User, Mail, Phone, Calendar, ArrowRight, Loader2, CheckCircle2 } from "lucide-react";

const CLINICS = [
  { id: "455b4027-5a91-4aa6-89b3-d9ebb8357169", name: "Downtown Medical Center", location: "New York, NY" },
  { id: "0662fa5e-dfc1-4eaa-874a-79b898253646", name: "Westside Health Clinic", location: "Los Angeles, CA" },
  { id: "fdf96b85-bb72-4e54-8877-ab53ae7c8ded", name: "Sunrise Family Care", location: "Miami, FL" },
];

export default function LeadCaptureForm() {
  const [formData, setFormData] = useState({
    clinicId: "",
    name: "",
    email: "",
    phone: "",
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState("");

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
      <div className="w-full max-w-xl mx-auto p-8 rounded-3xl bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl flex flex-col items-center justify-center text-center space-y-4 animate-in fade-in zoom-in duration-500">
        <div className="w-20 h-20 bg-green-500/20 text-green-400 rounded-full flex items-center justify-center mb-4">
          <CheckCircle2 size={40} />
        </div>
        <h3 className="text-3xl font-bold text-white tracking-tight">Request Received!</h3>
        <p className="text-zinc-300 text-lg">
          Thank you for choosing us. Our relationship manager will contact you shortly to confirm your booking and answer any questions.
        </p>
        <button
          onClick={() => setIsSuccess(false)}
          className="mt-8 px-8 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white font-medium transition-all"
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
            <select
              name="clinicId"
              required
              value={formData.clinicId}
              onChange={handleChange}
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-white focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 outline-none transition-all appearance-none"
            >
              <option value="" disabled className="bg-zinc-900">Choose a location...</option>
              {CLINICS.map((clinic) => (
                <option key={clinic.id} value={clinic.id} className="bg-zinc-900">
                  {clinic.name} - {clinic.location}
                </option>
              ))}
            </select>
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
