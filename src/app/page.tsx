"use client";

import React from "react";
import { LoginScreen } from "@/components/dashboard/login-screen";
import { ParticlesBackground } from "@/components/ui/particles-background";

export default function Home() {
  return (
    <div className="bg-[#09090b] relative">
      <div className="fixed inset-0 z-0 pointer-events-none">
        <ParticlesBackground />
      </div>
      <LoginScreen />
    </div>
  );
}
