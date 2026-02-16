"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Settings,
  LogOut,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { ParticlesBackground } from "@/components/ui/particles-background";

interface UserInfo {
  name: string;
  email: string;
  picture: string;
}

type Tab = "dashboard" | "settings";

export default function DashboardPage() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me", { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated) {
            setUser(data.user);
            setLoading(false);
          } else {
            router.replace("/");
          }
        } else {
          router.replace("/");
        }
      } catch {
        router.replace("/");
      }
    }
    checkAuth();

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [router]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  const handleReauth = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/api/auth/login";
  };

  const links = [
    {
      label: "Dashboard",
      href: "#",
      icon: (
        <LayoutDashboard className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
    {
      label: "Settings",
      href: "#",
      icon: (
        <Settings className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
    {
      label: "Logout",
      href: "#",
      icon: (
        <LogOut className="text-neutral-700 dark:text-neutral-200 h-5 w-5 flex-shrink-0" />
      ),
    },
  ];

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-6 w-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          <span className="text-zinc-500 font-mono text-xs tracking-wider uppercase">
            Loading
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col md:flex-row bg-[#09090b] w-full flex-1 overflow-hidden relative",
        "h-screen"
      )}
    >
      <ParticlesBackground />
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-10">
          <div className="flex flex-col flex-1 overflow-y-auto">
            <Logo open={open} />
            <div className="mt-8 flex flex-col gap-2">
              {links.map((link, idx) => {
                if (link.label === "Logout") {
                  return (
                    <button
                      key={idx}
                      onClick={handleLogout}
                      className={`flex items-center gap-2 group/sidebar py-2 w-full whitespace-nowrap ${!open ? 'justify-center' : ''}`}
                    >
                      {link.icon}
                      {open && (
                        <span className="text-neutral-200 text-sm group-hover/sidebar:translate-x-1 transition duration-150 whitespace-nowrap">
                          {link.label}
                        </span>
                      )}
                    </button>
                  );
                }
                return (
                  <button
                    key={idx}
                    onClick={() => setActiveTab(link.label.toLowerCase() as Tab)}
                    className={`flex items-center gap-2 group/sidebar py-2 w-full whitespace-nowrap ${!open ? 'justify-center' : ''}`}
                  >
                    {link.icon}
                    {open && (
                      <span className="text-neutral-200 text-sm group-hover/sidebar:translate-x-1 transition duration-150 whitespace-nowrap">
                        {link.label}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={!open ? 'flex justify-center' : ''}>
            <SidebarLink
              link={{
                label: user?.name || "User",
                href: "#",
                icon: user?.picture ? (
                  <img
                    src={user.picture}
                    className="h-7 w-7 flex-shrink-0 rounded-full"
                    alt="Avatar"
                  />
                ) : (
                  <div className="h-7 w-7 flex-shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-[0.6rem] font-bold text-white">
                    {(user?.name || "U").charAt(0).toUpperCase()}
                  </div>
                ),
              }}
            />
          </div>
        </SidebarBody>
      </Sidebar>
      <div className={activeTab === "dashboard" ? "flex flex-1" : "hidden"}>
        <DashboardView />
      </div>
      {activeTab === "settings" && (
        <SettingsPanel user={user} onReauth={handleReauth} />
      )}
    </div>
  );
}

const Logo = ({ open }: { open: boolean }) => {
  return (
    <div className={`flex items-center gap-2 py-1 relative z-20 ${!open ? 'justify-center' : ''}`}>
      <img
        src="/sync-icon.png"
        alt="Sync"
        style={{ width: 32, height: 32, minWidth: 32, minHeight: 32 }}
        className="flex-shrink-0 object-contain"
      />
      {open && (
        <span className="font-medium text-white whitespace-nowrap text-sm">
          Google Docs
        </span>
      )}
    </div>
  );
};

function SettingsPanel({
  user,
  onReauth,
}: {
  user: UserInfo | null;
  onReauth: () => void;
}) {
  return (
    <div className="flex flex-1">
      <div className="p-2 md:p-5 rounded-tl-2xl border border-white/[0.04] bg-[#09090b] flex flex-col gap-4 flex-1 w-full h-full overflow-y-auto">
        <h2 className="text-[0.6rem] font-bold uppercase tracking-[2px] text-zinc-500">
          Settings
        </h2>

        <div className="card-sovereign p-5">
          <div className="text-[0.55rem] font-bold uppercase tracking-[1.5px] text-zinc-600 mb-3">
            Account
          </div>
          <div className="flex items-center gap-3">
            {user?.picture ? (
              <img
                src={user.picture}
                className="h-9 w-9 rounded-full"
                alt="Avatar"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-xs font-bold text-white">
                {(user?.name || "U").charAt(0).toUpperCase()}
              </div>
            )}
            <div>
              <div className="text-[13px] font-semibold text-zinc-200">
                {user?.name || "User"}
              </div>
              <div className="text-[11px] font-mono text-zinc-600">
                {user?.email || ""}
              </div>
            </div>
          </div>
        </div>

        <div className="card-sovereign p-5">
          <div className="flex items-center gap-2 mb-3">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            <div className="text-[0.55rem] font-bold uppercase tracking-[1.5px] text-zinc-600">
              Authentication &amp; Scopes
            </div>
          </div>
          <p className="text-[13px] text-zinc-500 mb-1 leading-relaxed">
            SyncStream requires full <span className="font-mono text-zinc-300">documents</span> write
            and <span className="font-mono text-zinc-300">drive.file</span> access to append text to
            your Google Docs.
          </p>
          <p className="text-[12px] text-zinc-600 mb-4 leading-relaxed">
            If you see &quot;Insufficient Authentication Scopes&quot;, click below to
            clear your current token and re-authorize with the correct
            permissions.
          </p>
          <button
            onClick={onReauth}
            className="px-5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[13px] font-semibold tracking-wide hover:bg-amber-500/20 hover:border-amber-500/30 transition-all"
          >
            Re-authenticate with Google
          </button>
        </div>

        <div className="card-sovereign p-5">
          <div className="text-[0.55rem] font-bold uppercase tracking-[1.5px] text-zinc-600 mb-3">
            Required OAuth Scopes
          </div>
          <div className="flex flex-col gap-1.5">
            {[
              "googleapis.com/auth/documents",
              "googleapis.com/auth/drive.file",
              "googleapis.com/auth/drive.readonly",
              "googleapis.com/auth/userinfo.profile",
              "googleapis.com/auth/userinfo.email",
            ].map((scope) => (
              <div
                key={scope}
                className="text-[11px] font-mono text-zinc-600 px-2 py-1 bg-[#09090b] border border-white/[0.03] rounded"
              >
                https://{scope}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
