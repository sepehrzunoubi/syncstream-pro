"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Workspace } from "@/components/workspace/workspace";
import type { HeaderUser } from "@/components/workspace/header";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<HeaderUser | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    fetch("/api/auth/me", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.authenticated) {
          setUser(data.user);
          setChecked(true);
        } else router.replace("/");
      })
      .catch(() => router.replace("/"))
      .finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [router]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };
  const reauth = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/api/auth/login";
  };

  if (!checked) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }
  return <Workspace user={user} onSignOut={signOut} onReauth={reauth} />;
}
