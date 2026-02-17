"use client";

import React, { useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { KeyRound, ShieldCheck, AlertTriangle, Lock, Loader2 } from "lucide-react";

interface KeyGateProps {
  userEmail: string;
  onKeyRedeemed: (key: string) => void;
}

export function KeyGate({ userEmail, onKeyRedeemed }: KeyGateProps) {
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleRedeem = useCallback(async () => {
    if (!keyInput.trim() || isSubmitting) return;

    setError("");
    setIsSubmitting(true);

    try {
      const res = await fetch("/api/keys/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: keyInput.trim() }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to redeem key.");
        setIsSubmitting(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        onKeyRedeemed(data.key);
      }, 1500);
    } catch {
      setError("Network error. Please try again.");
      setIsSubmitting(false);
    }
  }, [keyInput, isSubmitting, onKeyRedeemed]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-[#09090b]/95 backdrop-blur-md" />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className="relative w-full max-w-md mx-4"
      >
        <div className="card-sovereign p-6 relative overflow-hidden">
          {/* Top accent line */}
          <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-blue-500 to-transparent opacity-60" />

          {/* Icon */}
          <div className="flex justify-center mb-5">
            <motion.div
              initial={{ rotate: -10 }}
              animate={{ rotate: 0 }}
              transition={{ type: "spring", stiffness: 200, damping: 15 }}
              className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center"
            >
              <KeyRound className="w-7 h-7 text-blue-400" />
            </motion.div>
          </div>

          {/* Title */}
          <h2 className="text-center text-lg font-semibold text-zinc-100 mb-1">
            Activate SyncStream
          </h2>
          <p className="text-center text-[13px] text-zinc-500 mb-5">
            Enter your license key to unlock full access.
          </p>

          {/* Warning card */}
          <div className="bg-amber-500/5 border border-amber-500/15 rounded-lg p-3.5 mb-5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-[12px] font-semibold text-amber-400 mb-1">
                  Permanent Account Binding
                </div>
                <p className="text-[11px] text-amber-400/70 leading-relaxed">
                  Once redeemed, this key will be <strong className="text-amber-300">permanently bound</strong> to
                  your Google account (<span className="font-mono text-amber-300">{userEmail}</span>).
                  You will only be able to access SyncStream using this Google account.
                  This action cannot be undone.
                </p>
              </div>
            </div>
          </div>

          {/* Success state */}
          <AnimatePresence mode="wait">
            {success ? (
              <motion.div
                key="success"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center gap-3 py-4"
              >
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                  <ShieldCheck className="w-6 h-6 text-emerald-400" />
                </div>
                <div className="text-[13px] font-semibold text-emerald-400">
                  Key Activated Successfully
                </div>
                <div className="text-[11px] text-zinc-600">
                  Redirecting to dashboard...
                </div>
              </motion.div>
            ) : (
              <motion.div key="form" initial={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {/* Key input */}
                <div className="relative mb-4">
                  <input
                    type="text"
                    value={keyInput}
                    onChange={(e) => {
                      setKeyInput(e.target.value.toUpperCase());
                      setError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && confirmed) handleRedeem();
                    }}
                    placeholder="SYNCLIFETIME-XXXXX-XXXXX-XXXXX"
                    disabled={isSubmitting}
                    className="w-full px-4 py-3 bg-[#09090b] border border-white/[0.06] rounded-lg text-[13px] font-mono text-zinc-200 placeholder-zinc-700 focus:outline-none focus:border-blue-500/40 focus:ring-1 focus:ring-blue-500/20 transition-all disabled:opacity-50"
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    autoCorrect="off"
                  />
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-700" />
                </div>

                {/* Error */}
                <AnimatePresence>
                  {error && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mb-3 overflow-hidden"
                    >
                      <div className="text-[12px] text-red-400 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
                        {error}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Confirmation checkbox */}
                <label className="flex items-start gap-2.5 mb-5 cursor-pointer group">
                  <div className="relative mt-0.5">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                      className="sr-only"
                    />
                    <div
                      className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
                        confirmed
                          ? "bg-blue-500 border-blue-500"
                          : "bg-transparent border-zinc-600 group-hover:border-zinc-400"
                      }`}
                    >
                      {confirmed && (
                        <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                          <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  </div>
                  <span className="text-[11px] text-zinc-500 leading-relaxed select-none">
                    I understand that this key will be permanently bound to my Google account
                    and cannot be transferred to another account without using the one-time reset.
                  </span>
                </label>

                {/* Submit button */}
                <button
                  onClick={handleRedeem}
                  disabled={!keyInput.trim() || !confirmed || isSubmitting}
                  className="w-full py-3 rounded-lg bg-blue-500 hover:bg-blue-400 disabled:opacity-30 disabled:cursor-not-allowed text-white text-[13px] font-semibold tracking-wide transition-all shadow-[0_0_12px_rgba(59,130,246,0.15)] hover:shadow-[0_0_20px_rgba(59,130,246,0.3)] flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Activating...
                    </>
                  ) : (
                    <>
                      <ShieldCheck className="w-4 h-4" />
                      Activate Key
                    </>
                  )}
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer */}
          <div className="mt-5 pt-4 border-t border-white/[0.04]">
            <p className="text-[10px] text-zinc-700 text-center leading-relaxed">
              Your license key is a lifetime access pass. It binds to one Google account
              and grants access across all devices using that account.
            </p>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
