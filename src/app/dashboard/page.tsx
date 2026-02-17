"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Sidebar, SidebarBody, useSidebar } from "@/components/ui/sidebar";
import {
  LayoutDashboard,
  Settings,
  LogOut,
  ShieldAlert,
  ChevronsRight,
  KeyRound,
  Lock,
  Copy,
  AlertTriangle,
  RotateCcw,
  ShieldCheck,
  Loader2,
  FileText,
  Shield,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { DashboardView } from "@/components/dashboard/dashboard-view";
import { ParticlesBackground } from "@/components/ui/particles-background";
import { KeyGate } from "@/components/dashboard/key-gate";

interface UserInfo {
  name: string;
  email: string;
  picture: string;
}

interface KeyStatus {
  hasKey: boolean;
  key: string | null;
  boundAt: number | null;
  resetUsed: boolean;
}

type Tab = "dashboard" | "settings";

export default function DashboardPage() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [keyLoading, setKeyLoading] = useState(true);

  const fetchKeyStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/keys/status");
      if (res.ok) {
        const data = await res.json();
        setKeyStatus(data);
      } else {
        // Fail-closed: if we can't verify key status, assume no key
        setKeyStatus({ hasKey: false, key: null, boundAt: null, resetUsed: false });
      }
    } catch {
      // Fail-closed: network error means we can't verify, block access
      setKeyStatus({ hasKey: false, key: null, boundAt: null, resetUsed: false });
    } finally {
      setKeyLoading(false);
    }
  }, []);

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
            fetchKeyStatus();
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
  }, [router, fetchKeyStatus]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  const handleReauth = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/api/auth/login";
  };

  const handleKeyRedeemed = useCallback((key: string) => {
    setKeyStatus({ hasKey: true, key, boundAt: Date.now(), resetUsed: false });
  }, []);

  const navItems: { label: string; tab?: Tab; icon: React.ReactNode; action?: () => void }[] = [
    { label: "Dashboard", tab: "dashboard", icon: <LayoutDashboard className="h-[18px] w-[18px]" /> },
    { label: "Settings",  tab: "settings",  icon: <Settings className="h-[18px] w-[18px]" /> },
    { label: "Logout",    action: handleLogout, icon: <LogOut className="h-[18px] w-[18px]" /> },
  ];

  // Fail-closed: if keyStatus is null or hasKey is false, show the gate
  const showKeyGate = !loading && !keyLoading && (!keyStatus || !keyStatus.hasKey);

  if (loading || keyLoading) {
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

  if (showKeyGate) {
    return (
      <div className="relative h-screen bg-[#09090b]">
        <ParticlesBackground />
        <KeyGate
          userEmail={user?.email || ""}
          onKeyRedeemed={handleKeyRedeemed}
        />
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
        <SettingsPanel
          user={user}
          onReauth={handleReauth}
          keyStatus={keyStatus}
          onKeyStatusChange={fetchKeyStatus}
          onLogout={handleLogout}
        />
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
  keyStatus,
  onLogout,
}: {
  user: UserInfo | null;
  onReauth: () => void;
  keyStatus: KeyStatus | null;
  onKeyStatusChange: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [resetStep, setResetStep] = useState<"idle" | "confirm" | "final" | "resetting" | "done">("idle");
  const [resetError, setResetError] = useState("");
  const [copied, setCopied] = useState(false);

  const handleCopyKey = useCallback(async () => {
    if (!keyStatus?.key) return;
    try {
      await navigator.clipboard.writeText(keyStatus.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = keyStatus.key;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [keyStatus?.key]);

  const handleResetKey = useCallback(async () => {
    setResetStep("resetting");
    setResetError("");

    try {
      const res = await fetch("/api/keys/reset", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setResetError(data.error || "Failed to reset key.");
        setResetStep("final");
        return;
      }

      // Copy key to clipboard
      if (data.key) {
        try {
          await navigator.clipboard.writeText(data.key);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = data.key;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
      }

      setResetStep("done");

      // Log out after short delay
      setTimeout(async () => {
        await onLogout();
      }, 2500);
    } catch {
      setResetError("Network error. Please try again.");
      setResetStep("final");
    }
  }, [onLogout]);

  const maskedKey = keyStatus?.key
    ? keyStatus.key.slice(0, 14) + "***-*****-*****"
    : null;

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

        {/* ═══ License Key Card ═══ */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
          className="card-sovereign p-5"
        >
          <div className="flex items-center gap-2 mb-3">
            <KeyRound className="h-4 w-4 text-blue-400" />
            <div className="text-[0.55rem] font-bold uppercase tracking-[1.5px] text-zinc-600">
              License Key
            </div>
            {keyStatus?.hasKey && (
              <div className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <ShieldCheck className="w-3 h-3 text-emerald-400" />
                <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider">
                  Active
                </span>
              </div>
            )}
          </div>

          {keyStatus?.hasKey ? (
            <>
              {/* Bound key display */}
              <div className="flex items-center gap-2 mb-3">
                <div className="flex-1 px-3 py-2.5 bg-[#09090b] border border-white/[0.06] rounded-lg flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                  <span className="font-mono text-[12px] text-zinc-400 select-none">
                    {maskedKey}
                  </span>
                </div>
                <button
                  onClick={handleCopyKey}
                  className="px-3 py-2.5 rounded-lg bg-zinc-800 border border-white/[0.06] hover:border-zinc-500/30 text-zinc-500 hover:text-zinc-300 transition-all flex items-center gap-1.5"
                  title="Copy key to clipboard"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[11px] font-medium">
                    {copied ? "Copied!" : "Copy"}
                  </span>
                </button>
              </div>

              <div className="text-[11px] text-zinc-600 mb-4">
                Bound to <span className="font-mono text-zinc-500">{user?.email}</span>
                {keyStatus.boundAt && (
                  <> on {new Date(keyStatus.boundAt).toLocaleDateString()}</>
                )}
              </div>

              {/* Reset key section */}
              <div className="border-t border-white/[0.04] pt-4">
                <AnimatePresence mode="wait">
                  {resetStep === "idle" && (
                    <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <button
                        onClick={() => setResetStep("confirm")}
                        disabled={keyStatus.resetUsed}
                        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/5 border border-red-500/15 text-red-400/80 text-[12px] font-semibold hover:bg-red-500/10 hover:border-red-500/25 hover:text-red-400 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        {keyStatus.resetUsed ? "Reset Already Used" : "Reset Key"}
                      </button>
                      {keyStatus.resetUsed && (
                        <p className="text-[10px] text-zinc-700 mt-2">
                          You have already used your one-time key reset.
                        </p>
                      )}
                    </motion.div>
                  )}

                  {resetStep === "confirm" && (
                    <motion.div
                      key="confirm"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                    >
                      <div className="bg-red-500/5 border border-red-500/15 rounded-lg p-4 mb-3">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                          <div>
                            <div className="text-[12px] font-semibold text-red-400 mb-1">
                              Warning: This action is permanent
                            </div>
                            <p className="text-[11px] text-red-400/70 leading-relaxed">
                              Resetting your key will <strong className="text-red-300">unbind it from this Google account</strong>,
                              copy it to your clipboard, and log you out. You can then redeem it on a different
                              Google account. <strong className="text-red-300">This can only be done once — ever.</strong>
                            </p>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setResetStep("final")}
                          className="px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[12px] font-semibold hover:bg-red-500/20 transition-all"
                        >
                          I Understand, Continue
                        </button>
                        <button
                          onClick={() => setResetStep("idle")}
                          className="px-4 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] text-zinc-500 text-[12px] font-semibold hover:text-zinc-300 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {resetStep === "final" && (
                    <motion.div
                      key="final"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                    >
                      <div className="bg-red-500/8 border border-red-500/20 rounded-lg p-4 mb-3">
                        <div className="flex items-start gap-2.5">
                          <AlertTriangle className="w-5 h-5 text-red-500 mt-0.5 flex-shrink-0 animate-pulse" />
                          <div>
                            <div className="text-[13px] font-bold text-red-400 mb-1">
                              FINAL CONFIRMATION
                            </div>
                            <p className="text-[11px] text-red-400/80 leading-relaxed mb-2">
                              Are you absolutely sure? This will:
                            </p>
                            <ul className="text-[11px] text-red-400/70 leading-relaxed space-y-1">
                              <li>- Unbind your key from <strong className="text-red-300">{user?.email}</strong></li>
                              <li>- Copy your key to your clipboard</li>
                              <li>- Log you out immediately</li>
                              <li>- <strong className="text-red-300">Permanently consume your one-time reset</strong></li>
                            </ul>
                          </div>
                        </div>
                      </div>
                      {resetError && (
                        <div className="text-[12px] text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2 mb-3">
                          {resetError}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleResetKey}
                          className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-400 text-white text-[12px] font-bold tracking-wide transition-all shadow-[0_0_12px_rgba(239,68,68,0.2)]"
                        >
                          Reset Key &amp; Log Out
                        </button>
                        <button
                          onClick={() => { setResetStep("idle"); setResetError(""); }}
                          className="px-4 py-2 rounded-lg bg-zinc-800 border border-white/[0.06] text-zinc-500 text-[12px] font-semibold hover:text-zinc-300 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </motion.div>
                  )}

                  {resetStep === "resetting" && (
                    <motion.div
                      key="resetting"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="flex items-center gap-3 py-2"
                    >
                      <Loader2 className="w-4 h-4 text-red-400 animate-spin" />
                      <span className="text-[12px] text-red-400 font-medium">
                        Resetting key and copying to clipboard...
                      </span>
                    </motion.div>
                  )}

                  {resetStep === "done" && (
                    <motion.div
                      key="done"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex flex-col items-center gap-2 py-3"
                    >
                      <ShieldCheck className="w-5 h-5 text-emerald-400" />
                      <span className="text-[12px] text-emerald-400 font-semibold">
                        Key reset successful. Copied to clipboard.
                      </span>
                      <span className="text-[11px] text-zinc-600">
                        Logging you out...
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          ) : (
            <div className="text-[12px] text-zinc-600">
              No license key bound to this account.
            </div>
          )}
        </motion.div>

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

        {/* ═══ Legal ═══ */}
        <div className="card-sovereign p-5">
          <div className="flex items-center gap-2 mb-3">
            <FileText className="h-4 w-4 text-zinc-500" />
            <div className="text-[0.55rem] font-bold uppercase tracking-[1.5px] text-zinc-600">
              Legal
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] hover:border-zinc-500/30 text-zinc-400 hover:text-zinc-200 text-[12px] font-semibold transition-all"
            >
              <Shield className="w-3.5 h-3.5" />
              Privacy Policy
            </a>
            <a
              href="/tos"
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#09090b] border border-white/[0.06] hover:border-zinc-500/30 text-zinc-400 hover:text-zinc-200 text-[12px] font-semibold transition-all"
            >
              <FileText className="w-3.5 h-3.5" />
              Terms of Service
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
