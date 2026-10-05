"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Check, Copy, Menu as MenuIcon, Send, Square, Wand2 } from "lucide-react";
import { AccountMenu, type HeaderUser } from "@/components/workspace/header";
import { WorkspaceTabs } from "@/components/workspace/workspace-tabs";
import { transformationSummary } from "@/lib/style-engine";
import { countWords } from "@/lib/format";
import { loadStyleDraft, saveStyleDraft, setStyleHandoff } from "./style-store";
import { fetchStyleStatus, streamStyle, StyleApiError, type StreamUsage, type StyleStatus } from "./style-api";
import { DiffView } from "./diff-view";

/**
 * The Style engine tab: paste text, get it back in the compiled style.
 * The style itself is trained and shipped by the developer; nothing here
 * changes it.
 */
export function StyleWorkspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [result, setResult] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<StyleStatus | null>(null);
  const [running, setRunning] = useState<null | "transform" | "revise">(null);
  const abortRef = useRef<AbortController | null>(null);
  const [usage, setUsage] = useState<StreamUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [copied, setCopied] = useState(false);
  const [railOpen, setRailOpen] = useState(false);

  useEffect(() => {
    const d = loadStyleDraft();
    setText(d.text);
    setResult(d.result);
    setLoaded(true);
    fetchStyleStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => saveStyleDraft({ text, result }), 300);
    return () => clearTimeout(id);
  }, [loaded, text, result]);

  useEffect(() => {
    if (!snack) return;
    const id = setTimeout(() => setSnack(null), 6000);
    return () => clearTimeout(id);
  }, [snack]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const summary = useMemo(() => (result && text && !running ? transformationSummary(text.trim(), result) : null), [text, result, running]);

  const fail = (err: unknown) => {
    if (err instanceof StyleApiError && err.status === 401) setError("Your Google sign-in expired. Choose Reconnect Google account in the account menu.");
    else setError(err instanceof Error ? err.message : "Something went wrong.");
  };

  const run = useCallback(async (mode: "transform" | "revise") => {
    const source = text.trim();
    if (!source || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(mode);
    setError(null);
    setShowChanges(false);
    let out = "";
    const draft = mode === "revise" ? result : "";
    setResult("");
    try {
      const u = await streamStyle("/api/style/transform", { text: source, ...(draft ? { draft } : {}) }, (chunk) => { out += chunk; setResult(out); }, controller.signal);
      setUsage(u);
      setResult(out.trim());
    } catch (err) {
      setResult(out.trim() || draft);
      if (controller.signal.aborted) setSnack("Stopped");
      else fail(err);
    } finally {
      setRunning(null);
      abortRef.current = null;
    }
  }, [text, result, running]);

  const stop = () => abortRef.current?.abort();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setSnack("Couldn't copy. Select the text and copy it instead.");
    }
  };

  const useInSync = () => {
    if (!result.trim()) return;
    if (!setStyleHandoff(result.trim())) { setSnack("Couldn't hand the text over: storage is full or blocked."); return; }
    router.push("/dashboard");
  };

  if (!loaded) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }

  const available = !status || (status.llm.configured && status.llm.reachable !== false && status.style.ready);
  const blocker = !status ? null
    : !status.style.ready ? "No style has been compiled for this deployment yet."
      : !status.llm.configured ? status.llm.detail
        : status.llm.reachable === false ? `The model server can't be reached (${status.llm.detail}).`
          : null;
  const subtitle = running === "transform" ? `Rewriting with ${status?.llm.model ?? "the model"}`
    : running === "revise" ? "Revising the draft toward the style"
      : blocker ?? (status ? `${status.style.name} style · ${status.style.samples} samples · ${status.llm.model}` : "Paste text and rewrite it in the house style");
  const busy = !!running;
  const ease = [0.2, 0, 0, 1] as const;

  return (
    <MotionConfig reducedMotion="user">
    <div className="ss-workspace">
      <header className="flex h-16 flex-none items-center gap-2 pl-2 pr-4">
        <button className="ss-icon-btn h-10 w-10 rounded-full" onClick={() => setRailOpen((o) => !o)} aria-label="About this style" title="About this style" aria-expanded={railOpen}>
          <MenuIcon className="h-5 w-5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sync-icon.png" alt="" className="hidden h-9 w-9 flex-none object-contain sm:block" />
        <div className="min-w-0 flex-1 pl-1">
          <div className="flex h-7 items-center gap-1">
            <span className="truncate px-1.5 text-[18px] leading-6">Style engine</span>
          </div>
          <div className="flex h-6 items-center gap-2 pl-1.5">
            <span className="truncate text-[12px] text-[var(--ss-text-3)]">{subtitle}</span>
          </div>
        </div>
        <WorkspaceTabs active="style" />
        {running ? (
          <button className="ss-btn ss-btn-outlined max-sm:w-10 max-sm:px-0" onClick={stop} title="Stop" aria-label="Stop">
            <Square className="h-[18px] w-[18px]" /><span className="max-sm:hidden">Stop</span>
          </button>
        ) : (
          <button className="ss-btn ss-btn-tonal max-sm:w-10 max-sm:px-0" onClick={() => run("transform")} disabled={!available || !text.trim()} title={blocker ?? (!text.trim() ? "Paste the text first" : "Rewrite in the house style")} aria-label="Rewrite">
            <Wand2 className="h-[18px] w-[18px]" /><span className="max-sm:hidden">Rewrite</span>
          </button>
        )}
        <AccountMenu user={user} onReauth={onReauth} onSignOut={onSignOut} />
      </header>

      <div className="ss-body flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <AnimatePresence initial={false}>
          {railOpen && (
            <motion.aside key="about" className="flex-none overflow-hidden lg:h-full" initial={{ width: 0, opacity: 0 }} animate={{ width: 264, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.22, ease }} aria-label="About this style">
              <div className="flex w-[264px] flex-col gap-3 px-6 pb-4 pt-2 text-[13px] leading-5 text-[var(--ss-text-2)]">
                <h2 className="text-[14px] font-medium text-[var(--ss-text)]">About this style</h2>
                {status ? (
                  <>
                    <p>{status.style.ready ? `Learned from ${status.style.samples} examples of the ${status.style.name} style.` : "No style compiled yet."}</p>
                    {status.style.evaluation && <p>Prompt {status.style.candidateId}, scored {Math.round(status.style.evaluation.score * 100)}% against held-out examples on {status.style.evaluation.model}.</p>}
                    <p>Runs on {status.llm.model} via {status.llm.provider}.</p>
                    {usage && <p>Last request: {usage.inputTokens.toLocaleString()} tokens in, {usage.outputTokens.toLocaleString()} out.</p>}
                  </>
                ) : <p>Checking the model server…</p>}
                <p className="text-[12px] text-[var(--ss-text-3)]">Every fact, name and number in your text is kept. Only the wording, pacing and punctuation change.</p>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        <main className="ss-canvas min-w-0 flex-none lg:h-full lg:flex-1">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-4 py-3 pb-16">
            {blocker && (
              <div role="alert" className="rounded-lg bg-[#fce8e6] p-4 text-[14px] leading-5 text-[#8c1d18]">{blocker}</div>
            )}
            {error && (
              <p role="alert" className="rounded-lg bg-[#fce8e6] p-3 text-[13px] leading-5 text-[#8c1d18]">{error}</p>
            )}
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="ss-card flex flex-col" aria-label="Your text">
                <div className="flex items-center gap-2 px-4 pt-3">
                  <h3 className="text-[14px] font-medium">Your text</h3>
                  <span className="flex-1" />
                  <span className="text-[12px] text-[var(--ss-text-3)]">{countWords(text).toLocaleString()} words</span>
                </div>
                <div className="px-4 pb-4 pt-2">
                  <textarea
                    className="ss-textarea"
                    rows={22}
                    value={text}
                    disabled={busy}
                    placeholder="Paste the text to rewrite"
                    spellCheck={false}
                    onChange={(e) => setText(e.target.value)}
                  />
                </div>
              </section>
              <section className="ss-card flex flex-col" aria-label="Result" aria-live={running ? "polite" : undefined}>
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                  <h3 className="text-[14px] font-medium">Result</h3>
                  <span className="flex-1" />
                  {result && !running && (
                    <>
                      <button className="ss-chip" data-selected={showChanges ? "true" : undefined} onClick={() => setShowChanges((v) => !v)} aria-pressed={showChanges}>
                        {showChanges ? "Hide changes" : "Show changes"}
                      </button>
                      <button className="ss-chip" onClick={copy}>
                        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
                      </button>
                      <button className="ss-chip" onClick={useInSync} title="Add this text to the sync editor as new text">
                        <Send className="h-3.5 w-3.5" /> Use in Sync
                      </button>
                    </>
                  )}
                </div>
                <div className="min-h-[200px] px-4 pb-4 pt-2">
                  {result || running ? (
                    showChanges ? (
                      <DiffView before={text.trim()} after={result} className="ss-result" />
                    ) : (
                      <div className="ss-result">
                        {result}
                        {running && <span className="ss-caret" aria-hidden="true" />}
                      </div>
                    )
                  ) : (
                    <p className="text-[14px] leading-5 text-[var(--ss-text-3)]">The rewritten text appears here as it is written.</p>
                  )}
                </div>
                {summary && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--ss-divider)] px-4 py-3 text-[12px] leading-4 text-[var(--ss-text-2)]">
                    <span>Words {summary.input.words} → {summary.output.words}</span>
                    <span>Sentences {summary.input.sentences} → {summary.output.sentences}</span>
                    <span>Words/sentence {summary.input.meanSentenceWords} → {summary.output.meanSentenceWords}</span>
                    <span>{Math.round(summary.edits.retention * 100)}% kept verbatim</span>
                    {summary.edits.droppedNames.length > 0 && (
                      <span className="text-[#8c5a00]">Check: the result doesn&apos;t repeat {summary.edits.droppedNames.slice(0, 6).join(", ")}{summary.edits.droppedNames.length > 6 ? "…" : ""}</span>
                    )}
                  </div>
                )}
              </section>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <button className="ss-btn ss-btn-outlined" onClick={stop}><Square className="h-[18px] w-[18px]" /> Stop</button>
              ) : (
                <>
                  <button className="ss-btn ss-btn-tonal" onClick={() => run("transform")} disabled={!available || !text.trim()}>
                    <Wand2 className="h-[18px] w-[18px]" /> Rewrite
                  </button>
                  {result && <button className="ss-btn ss-btn-text" onClick={() => run("revise")} disabled={!available} title="Ask the model to push this result closer to the style">Revise again</button>}
                </>
              )}
            </div>
          </div>
        </main>
      </div>

      <AnimatePresence>
        {snack && (
          <motion.div key={snack} className="ss-snackbar" role="status" initial={{ opacity: 0, y: 16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }} transition={{ type: "spring", stiffness: 500, damping: 38 }}>
            <span className="text-[14px]">{snack}</span>
            <button onClick={() => setSnack(null)}>Dismiss</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
