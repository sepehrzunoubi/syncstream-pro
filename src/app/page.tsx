"use client";

import React, { useState, useEffect } from "react";
import { Sidebar, SidebarBody, SidebarLink } from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Settings,
  LogOut,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { LoginScreen } from "@/components/dashboard/login-screen";

interface UserInfo {
  name: string;
  email: string;
  picture: string;
}

type Tab = "dashboard" | "settings";

export default function Home() {
  const [open, setOpen] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await fetch("/api/auth/me");
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated) {
            setAuthenticated(true);
            setUser(data.user);
          }
        }
      } catch {
        // not authenticated
      } finally {
        setLoading(false);
      }
    }
    checkAuth();
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuthenticated(false);
    setUser(null);
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
      <div className="flex items-center justify-center min-h-screen bg-[#0d1117]">
        <div className="text-neutral-500 font-mono text-sm animate-pulse">
          Loading…
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#09090b]">
        <LoginScreen />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col md:flex-row bg-[#09090b] w-full flex-1 overflow-hidden",
        "h-screen"
      )}
    >
      <Sidebar open={open} setOpen={setOpen}>
        <SidebarBody className="justify-between gap-10">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            {open ? <Logo /> : <LogoIcon />}
            <div className="mt-8 flex flex-col gap-2">
              {links.map((link, idx) => {
                if (link.label === "Logout") {
                  return (
                    <button
                      key={idx}
                      onClick={handleLogout}
                      className="flex items-center justify-start gap-2 group/sidebar py-2 w-full"
                    >
                      {link.icon}
                      <motion.span
                        animate={{
                          display: open ? "inline-block" : "none",
                          opacity: open ? 1 : 0,
                        }}
                        className="text-neutral-700 dark:text-neutral-200 text-sm group-hover/sidebar:translate-x-1 transition duration-150 whitespace-pre inline-block !p-0 !m-0"
                      >
                        {link.label}
                      </motion.span>
                    </button>
                  );
                }
                return (
                  <button
                    key={idx}
                    onClick={() => setActiveTab(link.label.toLowerCase() as Tab)}
                    className="flex items-center justify-start gap-2 group/sidebar py-2 w-full"
                  >
                    {link.icon}
                    <motion.span
                      animate={{
                        display: open ? "inline-block" : "none",
                        opacity: open ? 1 : 0,
                      }}
                      className="text-neutral-700 dark:text-neutral-200 text-sm group-hover/sidebar:translate-x-1 transition duration-150 whitespace-pre inline-block !p-0 !m-0"
                    >
                      {link.label}
                    </motion.span>
                  </button>
                );
              })}
            </div>
          </div>
          <div>
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
      {activeTab === "dashboard" && <DashboardView />}
      {activeTab === "settings" && (
        <SettingsPanel user={user} onReauth={handleReauth} />
      )}
    </div>
  );
}

const Logo = () => {
  return (
    <Link
      href="#"
      className="font-normal flex space-x-2 items-center text-sm text-black py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-black dark:bg-white rounded-br-lg rounded-tr-sm rounded-tl-lg rounded-bl-sm flex-shrink-0" />
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="font-medium text-black dark:text-white whitespace-pre"
      >
        SyncStream Pro
      </motion.span>
    </Link>
  );
};

const LogoIcon = () => {
  return (
    <Link
      href="#"
      className="font-normal flex space-x-2 items-center text-sm text-black py-1 relative z-20"
    >
      <div className="h-5 w-6 bg-black dark:bg-white rounded-br-lg rounded-tr-sm rounded-tl-lg rounded-bl-sm flex-shrink-0" />
    </Link>
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

        {/* Account */}
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

        {/* Auth Scopes */}
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

        {/* Scopes Reference */}
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
