import LeadCaptureForm from "@/components/LeadCaptureForm";

export default function Home() {
  return (
    <div className="min-h-screen bg-black font-sans selection:bg-blue-500/30">
      <main className="relative flex min-h-screen flex-col items-center justify-center p-6 md:p-24 overflow-hidden">
        {/* Background Effects */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
        <div className="absolute top-0 right-[15%] w-[40rem] h-[40rem] bg-blue-600/20 rounded-full blur-[120px] mix-blend-screen pointer-events-none" />
        <div className="absolute bottom-0 left-[15%] w-[40rem] h-[40rem] bg-purple-600/20 rounded-full blur-[120px] mix-blend-screen pointer-events-none" />

        <div className="relative z-10 w-full max-w-6xl flex flex-col lg:flex-row items-center gap-16 lg:gap-24">
          
          {/* Hero Section */}
          <div className="flex-1 flex flex-col items-center lg:items-start text-center lg:text-left space-y-8 animate-in slide-in-from-bottom-8 duration-700 fade-in">
            <div className="inline-flex items-center rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-sm font-medium text-blue-300 backdrop-blur-sm">
              <span className="flex h-2 w-2 rounded-full bg-blue-500 mr-2 animate-pulse"></span>
              Accepting New Patients
            </div>
            
            <h1 className="text-5xl lg:text-7xl font-extrabold tracking-tight text-white leading-[1.1]">
              Premium Care,<br />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">
                Tailored for You.
              </span>
            </h1>
            
            <p className="text-lg lg:text-xl text-zinc-400 max-w-xl leading-relaxed">
              Connect with top medical professionals at our state-of-the-art clinics. 
              Book an appointment today and experience healthcare excellence.
            </p>

            <div className="flex items-center gap-4 text-sm font-medium text-zinc-400 pt-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10 text-white">✓</div>
                Top Specialists
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center backdrop-blur-sm border border-white/10 text-white">✓</div>
                Modern Clinics
              </div>
            </div>
          </div>

          {/* Form Section */}
          <div className="flex-1 w-full animate-in slide-in-from-bottom-12 duration-700 delay-200 fade-in fill-mode-both">
            <LeadCaptureForm />
          </div>

        </div>
      </main>
    </div>
  );
}
