"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ArrowRight, Check, Copy, Menu as MenuIcon, Pencil, Plus, Send, Square, Wand2 } from "lucide-react";
import { AccountMenu, type HeaderUser } from "@/components/workspace/header";
import { WorkspaceTabs } from "@/components/workspace/workspace-tabs";
import { MAX_PAIRS, transformationSummary, usablePairs, type Effort, type StylePair, type StyleProfile } from "@/lib/style-engine";
import { corpusReport } from "@/lib/style-metrics";
import { countWords, formatClock } from "@/lib/format";
import { loadProfiles, loadSettings, newPair, newProfile, saveProfiles, saveSettings, setStyleHandoff } from "./style-store";
import { fetchStyleStatus, streamStyle, StyleApiError, type StreamUsage } from "./style-api";
import { StyleRail } from "./style-rail";
import { StylePanel } from "./style-panel";
import { PairCard } from "./pair-card";
import { DiffView } from "./diff-view";
import { SimpleMarkdown } from "./simple-markdown";

type Stage = "pairs" | "profile" | "transform";
const STAGES: { id: Stage; label: string }[] = [
  { id: "pairs", label: "Training pairs" },
  { id: "profile", label: "Transformation Profile" },
  { id: "transform", label: "Transform" },
];

type Status = { configured: boolean; model: string } | null;

export function StyleWorkspace({ user, onSignOut, onReauth }: { user: HeaderUser | null; onSignOut: () => void; onReauth: () => void }) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("pairs");
  const [effort, setEffort] = useState<Effort>("high");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [running, setRunning] = useState<null | "analyze" | "transform">(null);
  const abortRef = useRef<AbortController | null>(null);
  const [usage, setUsage] = useState<StreamUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [wide, setWide] = useState(true);
  const [editingProfile, setEditingProfile] = useState(false);
  const [showResultChanges, setShowResultChanges] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Restore the styles kept on this device
  useEffect(() => {
    let list = loadProfiles();
    if (!list.length) list = [newProfile()];
    const s = loadSettings();
    setProfiles(list);
    setSelectedId(s.selectedId && list.some((p) => p.id === s.selectedId) ? s.selectedId : list[0].id);
    setEffort(s.effort);
    if (s.stage) setStage(s.stage);
    setLoaded(true);
    fetchStyleStatus().then(setStatus);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      if (!saveProfiles(profiles)) setSnack("Couldn't keep your styles on this device: storage is full or blocked.");
      saveSettings({ effort, stage, selectedId: selectedId ?? undefined });
    }, 300);
    return () => clearTimeout(id);
  }, [loaded, profiles, effort, stage, selectedId]);

  // Layout: the styles list is a column on wide screens and a drawer on narrow ones
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1200px)");
    const apply = () => { setWide(mq.matches); setRailOpen(mq.matches); };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!snack) return;
    const id = setTimeout(() => setSnack(null), 6000);
    return () => clearTimeout(id);
  }, [snack]);

  // Stop a request when leaving the page
  useEffect(() => () => abortRef.current?.abort(), []);

  const profile = profiles.find((p) => p.id === selectedId) ?? null;
  const update = useCallback((id: string, patch: Partial<StyleProfile>) => {
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)));
  }, []);

  const pairs = useMemo(() => (profile ? usablePairs(profile.pairs) : []), [profile]);
  const report = useMemo(() => corpusReport(pairs), [pairs]);
  const draft = profile?.draftText ?? "";
  const result = profile?.result ?? "";
  const summary = useMemo(() => (result && draft && running !== "transform" ? transformationSummary(draft.trim(), result) : null), [draft, result, running]);

  const fail = (err: unknown) => {
    if (err instanceof StyleApiError && err.status === 401) setError("Your Google sign-in expired. Choose Reconnect Google account in the account menu.");
    else if (err instanceof StyleApiError && err.status === 503) { setError(err.message); setStatus((s) => ({ configured: false, model: s?.model ?? "" })); }
    else setError(err instanceof Error ? err.message : "Something went wrong.");
  };

  const analyze = useCallback(async () => {
    if (!profile || running) return;
    if (!pairs.length) { setError("Add at least one pair with both the source text and its adapted version."); return; }
    const id = profile.id;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning("analyze");
    setError(null);
    setStage("profile");
    setEditingProfile(false);
    let text = "";
    update(id, { analysis: "", analyzedAt: null });
    try {
      const u = await streamStyle("/api/style/analyze", { pairs, instructions: profile.instructions, effort }, (chunk) => { text += chunk; update(id, { analysis: text }); }, controller.signal);
      setUsage(u);
      update(id, { analysis: text.trim(), analyzedAt: Date.now() });
      setSnack("Transformation Profile ready");
    } catch (err) {
      const partial = text.trim();
      update(id, { analysis: partial || null, analyzedAt: partial ? Date.now() : null });
      if (controller.signal.aborted) setSnack(partial ? "Stopped. The profile so far is kept." : "Stopped");
      else fail(err);
    } finally {
      setRunning(null);
      abortRef.current = null;
    }
  }, [profile, running, pairs, effort, update]);

  const transform = useCallback(async () => {
    if (!profile || running) return;
    const text = draft.trim();
    if (!profile.analysis) { setError("Analyze the pairs first so there is a Transformation Profile to apply."); setStage("profile"); return; }
    if (!text) { setError("Paste the text you want transformed."); return; }
    const id = profile.id;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning("transform");
    setError(null);
    setShowResultChanges(false);
    let out = "";
    update(id, { result: "" });
    try {
      const u = await streamStyle("/api/style/transform", { pairs, analysis: profile.analysis, instructions: profile.instructions, text, effort }, (chunk) => { out += chunk; update(id, { result: out }); }, controller.signal);
      setUsage(u);
      update(id, { result: out.trim() });
    } catch (err) {
      update(id, { result: out.trim() });
      if (controller.signal.aborted) setSnack("Stopped");
      else fail(err);
    } finally {
      setRunning(null);
      abortRef.current = null;
    }
  }, [profile, running, draft, pairs, effort, update]);

  const stop = () => abortRef.current?.abort();

  const createProfile = () => {
    const p = newProfile();
    setProfiles((prev) => [p, ...prev]);
    setSelectedId(p.id);
    setStage("pairs");
    setError(null);
    if (!wide) setRailOpen(false);
  };

  const deleteProfile = () => {
    if (!profile || running) return;
    if (!window.confirm(`Delete "${profile.name || "Untitled style"}" and its pairs from this device?`)) return;
    const rest = profiles.filter((p) => p.id !== profile.id);
    const next = rest.length ? rest : [newProfile()];
    setProfiles(next);
    setSelectedId(next[0].id);
    setStage("pairs");
    setSnack("Style deleted");
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setSnack("Couldn't copy. Select the text and copy it instead.");
    }
  };

  const useInSync = () => {
    if (!result.trim()) return;
    if (!setStyleHandoff(result.trim())) { setSnack("Couldn't hand the text over: storage is full or blocked."); return; }
    router.push("/dashboard");
  };

  if (!loaded || !profile) {
    return (
      <div className="ss-workspace items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-[#d3e3fd] border-t-[#0b57d0]" role="status" aria-label="Loading" />
      </div>
    );
  }

  const configured = status?.configured !== false;
  const subtitle = running === "analyze"
    ? "Comparing the pairs and writing the Transformation Profile"
    : running === "transform"
      ? "Applying the profile to your text"
      : stage === "pairs"
        ? pairs.length ? `${pairs.length} ${pairs.length === 1 ? "pair" : "pairs"} ready to analyze` : "Add a source text and its adapted version"
        : stage === "profile"
          ? profile.analysis ? `Profile from ${formatClock(profile.analyzedAt ?? profile.updatedAt)}. Edit it if a rule is wrong.` : "Analyze the pairs to write the profile"
          : profile.analysis ? "Paste new text and apply the profile" : "Analyze the pairs first";

  const primary = running
    ? { label: "Stop", onClick: stop, disabled: false, icon: <Square className="h-[18px] w-[18px]" />, tonal: false, title: "Stop the request" }
    : stage === "transform" || (stage === "profile" && profile.analysis)
      ? stage === "profile"
        ? { label: "Transform text", onClick: () => setStage("transform"), disabled: false, icon: <ArrowRight className="h-[18px] w-[18px]" />, tonal: true, title: "Go to Transform" }
        : { label: "Transform", onClick: transform, disabled: !configured || !profile.analysis || !draft.trim(), icon: <Wand2 className="h-[18px] w-[18px]" />, tonal: true, title: !profile.analysis ? "Analyze the pairs first" : !draft.trim() ? "Paste the text to transform first" : "Apply the profile" }
      : { label: profile.analysis ? "Analyze again" : "Analyze pairs", onClick: analyze, disabled: !configured || !pairs.length, icon: <Wand2 className="h-[18px] w-[18px]" />, tonal: true, title: !pairs.length ? "Fill in a pair first" : "Compare the pairs and write the profile" };

  const ease = [0.2, 0, 0, 1] as const;
  const rail = <StyleRail profiles={profiles} selectedId={selectedId} onSelect={(id) => { if (running) return; setSelectedId(id); setError(null); setEditingProfile(false); if (!wide) setRailOpen(false); }} onCreate={createProfile} />;
  const busy = !!running;

  const setPair = (pair: StylePair) => update(profile.id, { pairs: profile.pairs.map((p) => (p.id === pair.id ? pair : p)) });
  const removePair = (id: string) => update(profile.id, { pairs: profile.pairs.filter((p) => p.id !== id) });
  const addPair = () => update(profile.id, { pairs: [...profile.pairs, newPair()] });

  return (
    <MotionConfig reducedMotion="user">
    <div className="ss-workspace">
      <header className="flex h-16 flex-none items-center gap-2 pl-2 pr-4">
        <button className="ss-icon-btn h-10 w-10 rounded-full" onClick={() => setRailOpen((o) => !o)} aria-label="Show or hide styles" title="Styles">
          <MenuIcon className="h-5 w-5" />
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sync-icon.png" alt="" className="hidden h-9 w-9 flex-none object-contain sm:block" />
        <div className="min-w-0 flex-1 pl-1">
          <div className="flex h-7 items-center gap-1">
            <input
              className="ss-title-input"
              value={profile.name}
              placeholder="Untitled style"
              aria-label="Style name"
              onChange={(e) => update(profile.id, { name: e.target.value.slice(0, 80) })}
            />
          </div>
          <div className="flex h-6 items-center gap-2 pl-1.5">
            <span className="truncate text-[12px] text-[var(--ss-text-3)]">{subtitle}</span>
          </div>
        </div>
        <WorkspaceTabs active="style" />
        <button
          className={`ss-btn ${primary.tonal ? "ss-btn-tonal" : "ss-btn-outlined"} max-sm:w-10 max-sm:px-0`}
          onClick={primary.onClick}
          disabled={primary.disabled}
          title={primary.title}
          aria-label={primary.label}
        >
          {primary.icon}
          <span className="max-sm:hidden">{primary.label}</span>
        </button>
        <AccountMenu user={user} onReauth={onReauth} onSignOut={onSignOut} />
      </header>

      <div className="ss-noprint flex-none px-4 pb-1">
        <div className="ss-toolbar" role="tablist" aria-label="Steps">
          {STAGES.map((s, i) => (
            <button key={s.id} role="tab" aria-selected={stage === s.id} data-on={stage === s.id ? "true" : undefined} className="ss-stage" onClick={() => setStage(s.id)}>
              <span className="ss-stage-num">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ss-body flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <AnimatePresence initial={false}>
          {railOpen && wide && (
            <motion.div key="rail" className="h-full flex-none overflow-hidden" initial={{ width: 0, opacity: 0 }} animate={{ width: 264, opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ duration: 0.22, ease }}>
              {rail}
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {railOpen && !wide && (
            <motion.div key="drawer" className="fixed inset-0 z-50 flex" role="dialog" aria-label="Styles">
              <motion.div className="h-full bg-[var(--ss-canvas)] pt-4 shadow-xl" initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ type: "spring", stiffness: 420, damping: 40 }}>
                {rail}
              </motion.div>
              <motion.button className="flex-1 bg-black/30" aria-label="Close styles" onClick={() => setRailOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
            </motion.div>
          )}
        </AnimatePresence>

        <main className="ss-canvas min-w-0 flex-none lg:h-full lg:flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${profile.id}:${stage}`} className="mx-auto flex max-w-[1040px] flex-col gap-4 px-4 py-3 pb-16" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease }}>
              {stage === "pairs" && (
                <>
                  <p className="text-[14px] leading-5 text-[var(--ss-text-2)]">
                    Show the engine what the adaptation does: a source text and the same text in the target style. Two or three pairs are enough to start; up to {MAX_PAIRS} are used. The engine measures each pair and then writes the rules it finds.
                  </p>
                  {profile.pairs.map((pair, i) => (
                    <PairCard key={pair.id} pair={pair} index={i} disabled={busy} canRemove={profile.pairs.length > 1} onChange={setPair} onRemove={() => removePair(pair.id)} />
                  ))}
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="ss-btn ss-btn-outlined" onClick={addPair} disabled={busy || profile.pairs.length >= MAX_PAIRS}>
                      <Plus className="h-[18px] w-[18px]" /> Add pair
                    </button>
                    <button className="ss-btn ss-btn-tonal" onClick={analyze} disabled={busy || !configured || !pairs.length} title={!pairs.length ? "Fill in a pair first" : undefined}>
                      <Wand2 className="h-[18px] w-[18px]" /> {profile.analysis ? "Analyze again" : "Analyze pairs"}
                    </button>
                    <span className="flex-1" />
                    <button className="ss-btn ss-btn-danger" onClick={deleteProfile} disabled={busy}>Delete style</button>
                  </div>
                </>
              )}

              {stage === "profile" && (
                <>
                  {profile.analysis == null && running !== "analyze" ? (
                    <section className="ss-card px-5 py-6 text-center">
                      <h3 className="text-[16px] font-medium">No Transformation Profile yet</h3>
                      <p className="mx-auto mt-1 max-w-[520px] text-[14px] leading-5 text-[var(--ss-text-2)]">
                        The engine compares each pair token by token, measures the shift in pacing, density and connectives, and writes the rules as a profile you can read and edit.
                      </p>
                      <button className="ss-btn ss-btn-tonal mt-4" onClick={analyze} disabled={busy || !configured || !pairs.length}>
                        <Wand2 className="h-[18px] w-[18px]" /> Analyze pairs
                      </button>
                    </section>
                  ) : (
                    <section className="ss-card" aria-live={running === "analyze" ? "polite" : undefined}>
                      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                        <h3 className="text-[14px] font-medium">Transformation Profile</h3>
                        <span className="flex-1" />
                        <button className="ss-chip" onClick={() => copy("profile", profile.analysis ?? "")} disabled={!profile.analysis}>
                          {copied === "profile" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === "profile" ? "Copied" : "Copy"}
                        </button>
                        <button className="ss-chip" data-selected={editingProfile ? "true" : undefined} onClick={() => setEditingProfile((v) => !v)} disabled={busy || !profile.analysis} aria-pressed={editingProfile}>
                          <Pencil className="h-3.5 w-3.5" /> {editingProfile ? "Done" : "Edit"}
                        </button>
                        <button className="ss-chip" onClick={analyze} disabled={busy || !configured || !pairs.length}>
                          <Wand2 className="h-3.5 w-3.5" /> Analyze again
                        </button>
                      </div>
                      <div className="px-4 pb-4 pt-2">
                        {editingProfile ? (
                          <textarea className="ss-textarea font-mono text-[13px]" rows={28} value={profile.analysis ?? ""} onChange={(e) => update(profile.id, { analysis: e.target.value })} spellCheck={false} aria-label="Transformation Profile" />
                        ) : (
                          <>
                            <SimpleMarkdown text={profile.analysis ?? ""} />
                            {running === "analyze" && <span className="ss-caret" aria-hidden="true" />}
                          </>
                        )}
                      </div>
                    </section>
                  )}
                  {profile.analysis && running !== "analyze" && (
                    <div className="flex justify-end">
                      <button className="ss-btn ss-btn-tonal" onClick={() => setStage("transform")}>
                        Transform text <ArrowRight className="h-[18px] w-[18px]" />
                      </button>
                    </div>
                  )}
                </>
              )}

              {stage === "transform" && (
                <>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <section className="ss-card flex flex-col" aria-label="Source text">
                      <div className="flex items-center gap-2 px-4 pt-3">
                        <h3 className="text-[14px] font-medium">Source text</h3>
                        <span className="flex-1" />
                        <span className="text-[12px] text-[var(--ss-text-3)]">{countWords(draft).toLocaleString()} words</span>
                      </div>
                      <div className="px-4 pb-4 pt-2">
                        <textarea
                          className="ss-textarea"
                          rows={20}
                          value={draft}
                          disabled={busy}
                          placeholder="Paste the text to adapt"
                          spellCheck={false}
                          onChange={(e) => update(profile.id, { draftText: e.target.value })}
                        />
                      </div>
                    </section>
                    <section className="ss-card flex flex-col" aria-label="Result" aria-live={running === "transform" ? "polite" : undefined}>
                      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                        <h3 className="text-[14px] font-medium">Result</h3>
                        <span className="flex-1" />
                        {result && running !== "transform" && (
                          <>
                            <button className="ss-chip" data-selected={showResultChanges ? "true" : undefined} onClick={() => setShowResultChanges((v) => !v)} aria-pressed={showResultChanges}>
                              {showResultChanges ? "Hide changes" : "Show changes"}
                            </button>
                            <button className="ss-chip" onClick={() => copy("result", result)}>
                              {copied === "result" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied === "result" ? "Copied" : "Copy"}
                            </button>
                            <button className="ss-chip" onClick={useInSync} title="Add this text to the sync editor as new text">
                              <Send className="h-3.5 w-3.5" /> Use in Sync
                            </button>
                          </>
                        )}
                      </div>
                      <div className="min-h-[200px] px-4 pb-4 pt-2">
                        {result || running === "transform" ? (
                          showResultChanges ? (
                            <DiffView before={draft.trim()} after={result} className="ss-result" />
                          ) : (
                            <div className="ss-result">
                              {result}
                              {running === "transform" && <span className="ss-caret" aria-hidden="true" />}
                            </div>
                          )
                        ) : (
                          <p className="text-[14px] leading-5 text-[var(--ss-text-3)]">
                            {profile.analysis ? "The adapted text appears here as it is written." : "Analyze the pairs first, then transform."}
                          </p>
                        )}
                      </div>
                      {summary && (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--ss-divider)] px-4 py-3 text-[12px] leading-4 text-[var(--ss-text-2)]">
                          <span>Words {summary.input.words} → {summary.output.words}</span>
                          <span>Sentences {summary.input.sentences} → {summary.output.sentences}</span>
                          <span>Words/sentence {summary.input.meanSentenceWords} → {summary.output.meanSentenceWords}</span>
                          <span>Transitions {summary.input.transitions.count} → {summary.output.transitions.count}</span>
                          <span>{Math.round(summary.edits.retention * 100)}% kept verbatim</span>
                          {summary.edits.droppedNames.length > 0 && (
                            <span className="text-[#8c5a00]">Check: the result doesn&apos;t repeat {summary.edits.droppedNames.slice(0, 6).join(", ")}{summary.edits.droppedNames.length > 6 ? "…" : ""}</span>
                          )}
                        </div>
                      )}
                    </section>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {running === "transform" ? (
                      <button className="ss-btn ss-btn-outlined" onClick={stop}><Square className="h-[18px] w-[18px]" /> Stop</button>
                    ) : (
                      <button className="ss-btn ss-btn-tonal" onClick={transform} disabled={busy || !configured || !profile.analysis || !draft.trim()}>
                        <Wand2 className="h-[18px] w-[18px]" /> Transform
                      </button>
                    )}
                    {!profile.analysis && <button className="ss-btn ss-btn-text" onClick={() => setStage("profile")}>Write the profile first</button>}
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </main>

        <aside className="flex-none bg-[var(--ss-surface)] lg:m-2 lg:mt-0 lg:h-[calc(100%-8px)] lg:w-[360px] lg:overflow-y-auto lg:overflow-x-hidden lg:rounded-2xl" aria-label="Engine settings">
          <StylePanel
            effort={effort}
            onEffortChange={setEffort}
            instructions={profile.instructions}
            onInstructionsChange={(v) => update(profile.id, { instructions: v })}
            report={report}
            status={status}
            usage={usage}
            disabled={busy}
            error={error}
          />
        </aside>
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
