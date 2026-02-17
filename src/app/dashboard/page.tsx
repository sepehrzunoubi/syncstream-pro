"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, SidebarBody, useSidebar } from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Settings,
  LogOut,
  ShieldAlert,
  ChevronsRight,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
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

  const navItems: { label: string; tab?: Tab; icon: React.ReactNode; action?: () => void }[] = [
    { label: "Dashboard", tab: "dashboard", icon: <LayoutDashboard className="h-[18px] w-[18px]" /> },
    { label: "Settings",  tab: "settings",  icon: <Settings className="h-[18px] w-[18px]" /> },
    { label: "Logout",    action: handleLogout, icon: <LogOut className="h-[18px] w-[18px]" /> },
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
        <SidebarBody className="justify-between gap-6">
          <div className="flex flex-col flex-1 overflow-y-auto overflow-x-hidden">
            {/* Logo */}
            <SidebarLogo />

            {/* Expand / collapse toggle */}
            <SidebarToggle />

            {/* Nav items */}
            <nav className="mt-2 flex flex-col gap-1">
              {navItems.map((item) => (
                <SidebarNavButton
                  key={item.label}
                  icon={item.icon}
                  label={item.label}
                  active={item.tab ? activeTab === item.tab : false}
                  onClick={() => item.action ? item.action() : item.tab && setActiveTab(item.tab)}
                />
              ))}
            </nav>
          </div>

          {/* User avatar */}
          <SidebarUserCard user={user} />
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

/* ── Animated label helper (shared by logo, nav, user card) ──────────── */
const LABEL_VARIANTS = {
  hidden: { opacity: 0, x: -4, width: 0, marginLeft: 0 },
  visible: { opacity: 1, x: 0, width: "auto", marginLeft: 8 },
};
const LABEL_TRANSITION = { duration: 0.18, ease: "easeOut" as const };

function SidebarLogo() {
  const { open } = useSidebar();
  return (
    <div className={cn("flex items-center py-1 relative z-20 mt-1", !open && "justify-center")}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/sync-icon.png"
        alt="Sync"
        className="flex-shrink-0 object-contain"
        style={{ width: 28, height: 28, minWidth: 28 }}
      />
      <AnimatePresence mode="wait">
        {open && (
          <motion.span
            key="logo-label"
            variants={LABEL_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={LABEL_TRANSITION}
            className="font-semibold text-[13px] text-white whitespace-nowrap overflow-hidden"
          >
            SyncStream
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function SidebarToggle() {
  const { open, toggle } = useSidebar();
  return (
    <div className={cn("mt-4 mb-1", !open && "flex justify-center")}>
      <button
        onClick={toggle}
        className={cn(
          "flex items-center gap-2 py-1.5 px-2 rounded-lg w-full",
          "text-zinc-600 hover:text-zinc-300 hover:bg-white/[0.04]",
          "transition-colors duration-150",
          !open && "justify-center w-auto"
        )}
        aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
      >
        <motion.div
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.25, ease: "easeInOut" }}
          className="flex-shrink-0 flex items-center justify-center w-5 h-5"
        >
          <ChevronsRight
            className={cn(
              "h-4 w-4",
              !open && "animate-[pulse-subtle_2s_ease-in-out_infinite]"
            )}
          />
        </motion.div>
        <AnimatePresence mode="wait">
          {open && (
            <motion.span
              key="toggle-label"
              variants={LABEL_VARIANTS}
              initial="hidden"
              animate="visible"
              exit="hidden"
              transition={LABEL_TRANSITION}
              className="text-[11px] font-medium uppercase tracking-wider whitespace-nowrap overflow-hidden"
            >
              Collapse
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </div>
  );
}

function SidebarNavButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const { open } = useSidebar();
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center py-2 px-2 rounded-lg w-full whitespace-nowrap overflow-hidden",
        "transition-colors duration-150",
        active
          ? "bg-white/[0.07] text-zinc-100"
          : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04]",
        !open && "justify-center"
      )}
    >
      <span className="flex-shrink-0 flex items-center justify-center w-5 h-5">
        {icon}
      </span>
      <AnimatePresence mode="wait">
        {open && (
          <motion.span
            key={label}
            variants={LABEL_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={LABEL_TRANSITION}
            className="text-[13px] font-medium whitespace-nowrap overflow-hidden"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

function SidebarUserCard({ user }: { user: UserInfo | null }) {
  const { open } = useSidebar();
  return (
    <div
      className={cn(
        "flex items-center py-2 px-2 rounded-lg",
        "border border-white/[0.04] bg-white/[0.02]",
        !open && "justify-center"
      )}
    >
      {user?.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.picture}
          className="h-7 w-7 flex-shrink-0 rounded-full"
          alt="Avatar"
        />
      ) : (
        <div className="h-7 w-7 flex-shrink-0 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-[0.6rem] font-bold text-white">
          {(user?.name || "U").charAt(0).toUpperCase()}
        </div>
      )}
      <AnimatePresence mode="wait">
        {open && (
          <motion.div
            key="user-info"
            variants={LABEL_VARIANTS}
            initial="hidden"
            animate="visible"
            exit="hidden"
            transition={LABEL_TRANSITION}
            className="overflow-hidden whitespace-nowrap"
          >
            <div className="text-[12px] font-semibold text-zinc-200 leading-tight">
              {user?.name || "User"}
            </div>
            <div className="text-[10px] font-mono text-zinc-600 leading-tight truncate max-w-[140px]">
              {user?.email || ""}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

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
