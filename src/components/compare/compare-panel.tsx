"use client";

/**
 * Compare & Sync's right panel: what the sync will add, every change in typing order (each can be
 * left out), what stays as it is, the sync settings and Start sync.
 */

import React, { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { FilePlus2, PanelBottom, PanelTop, PenLine, Rows3, Ruler, SeparatorHorizontal, Shuffle, Superscript, Table2, X } from "lucide-react";
import type { Change, ChangeKind, CompareResult, Kept, Unsupported } from "@/lib/compare-types";
import type { DripPlan } from "@/lib/drip-engine";
import { describeBreak, formatBreak, parseBreakLength } from "@/lib/breaks";
import { formatClock, formatSpan } from "@/lib/format";
import { DURATION_OPTIONS, START_OPTIONS, TYPO_OPTIONS, type ManualBreakRow } from "../workspace/sync-panel";
import { Icon } from "../workspace/icon";
import { CHANGE_LABEL, changeTitle, keptLine, plural, unsupportedLine } from "./compare-view";
import type { CompareSettings } from "./storage";

const ease = [0.2, 0, 0, 1] as const;
const lucide = (C: typeof Table2) => <C className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden="true" />;
const KIND_ICON: Record<ChangeKind, React.ReactNode> = {
  text: <Icon name="notes" size={18} />,
  paragraph: <Icon name="notes" size={18} />,
  list: <Icon name="format_list_bulleted" size={18} />,
  table: lucide(Table2),
  row: lucide(Rows3),
  cell: lucide(Table2),
  image: <Icon name="image" size={18} />,
  pageBreak: lucide(SeparatorHorizontal),
  footnote: lucide(Superscript),
  header: lucide(PanelTop),
  footer: lucide(PanelBottom),
  tab: lucide(FilePlus2),
  rename: lucide(PenLine),
  pageSetup: lucide(Ruler),
};

/** How many changes of a tab show before "Show all" */
const SHOWN = 50;

export interface ManualBreaksView {
  rows: ManualBreakRow[];
  /** Breaks placed in the other tabs */
  elsewhere: number;
  onRemove: (row: ManualBreakRow) => void;
  onClear: () => void;
  onHover: (row: ManualBreakRow | null) => void;
  onJump: (row: ManualBreakRow) => void;
  /** Whether the page has glowing words to put a break after */
  canPlace: boolean;
  /** Clicks on your document place breaks now */
  placing: boolean;
  onTogglePlacing: () => void;
  /** The length field changed (a length that reads starts placing) */
  onLength: (v: string) => void;
}

interface ComparePanelProps {
  /** With skipped changes left out: what the sync types */
  result: CompareResult;
  /** Every change, skipped ones included, for the list */
  full: CompareResult;
  skip: ReadonlySet<string>;
  onToggleSkip: (id: string) => void;
  onSkipAll: (ids: string[], skip: boolean) => void;
  onJump: (change: Change) => void;
  activeChange: string | null;
  settings: CompareSettings;
  onSettings: (patch: Partial<CompareSettings>) => void;
  manual: ManualBreaksView;
  plan: DripPlan | null;
  onShuffle: () => void;
  onStart: () => void;
  starting: boolean;
  /** Why Start can't run now, when it can't */
  blocked: string | null;
  startError: string | null;
  notice: React.ReactNode;
}

export function ComparePanel(p: ComparePanelProps) {
  const t = p.result.totals;
  const nothing = t.changes === 0;
  return (
    <div className="ss-cmp-panel">
      {p.notice}
      <Summary result={p.result} nothing={nothing} skipped={p.skip.size} />
      <ChangeList {...p} />
      <LeftAlone result={p.full} />
      {/* Nothing to type: no settings to choose and nothing to start */}
      {!nothing && <Settings {...p} />}
      {!nothing && <StartCard {...p} nothing={nothing} />}
    </div>
  );
}

function Summary({ result, nothing, skipped }: { result: CompareResult; nothing: boolean; skipped: number }) {
  const t = result.totals;
  const chips: [React.ReactNode, string][] = [];
  if (t.images) chips.push([<Icon key="i" name="image" size={16} />, plural(t.images, "image")]);
  if (t.tables) chips.push([<Table2 key="t" className="h-4 w-4" strokeWidth={1.75} />, plural(t.tables, "table")]);
  if (t.footnotes) chips.push([<Superscript key="f" className="h-4 w-4" strokeWidth={1.75} />, plural(t.footnotes, "footnote")]);
  if (t.newTabs) chips.push([<FilePlus2 key="n" className="h-4 w-4" strokeWidth={1.75} />, plural(t.newTabs, "new tab")]);
  const pct = Math.max(0, Math.min(100, Math.round(t.presentPct)));
  return (
    <section className="ss-cmp-summary" aria-label="Summary">
      {nothing ? (
        <div className="ss-cmp-uptodate">
          <span className="ss-cmp-uptodate-icon" aria-hidden="true"><Icon name="check" size={22} /></span>
          <div>
            <div className="ss-cmp-big">{skipped ? "Nothing left to copy" : "Already up to date"}</div>
            <p className="ss-cmp-sub">{skipped ? "You left every change out. Turn one back on to sync it." : "Your document already has everything in the reference."}</p>
          </div>
        </div>
      ) : (
        <>
          <div className="ss-cmp-big" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={t.words} className="inline-block" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.18, ease }}>
                {t.words ? plural(t.words, "word") : plural(t.changes, "change")}
              </motion.span>
            </AnimatePresence>
            <span className="ss-cmp-big-rest"> to add</span>
          </div>
          {chips.length > 0 && (
            <div className="ss-cmp-chips">
              {chips.map(([icon, label]) => <span key={label} className="ss-cmp-stat">{icon}{label}</span>)}
            </div>
          )}
        </>
      )}
      <div className="ss-cmp-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Already in your document">
        <motion.span className="ss-cmp-meter-fill" initial={false} animate={{ width: `${pct}%` }} transition={{ type: "spring", stiffness: 120, damping: 22 }} />
      </div>
      <p className="ss-cmp-meter-label"><span className="tabular-nums">{pct}%</span> of the reference is already in your document</p>
    </section>
  );
}

function ChangeList(p: ComparePanelProps) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  const tabs = p.full.tabs.filter((t) => t.changes.length > 0);
  const many = tabs.length > 1;
  const total = tabs.reduce((n, t) => n + t.changes.length, 0);
  if (!total) return null;
  const ids = tabs.flatMap((t) => t.changes.map((c) => c.id));
  const allOn = ids.every((id) => !p.skip.has(id));
  return (
    <section className="ss-cmp-section" aria-labelledby="ss-cmp-changes">
      <div className="ss-cmp-section-head">
        <h2 id="ss-cmp-changes" className="ss-cmp-h2">Changes <span className="ss-cmp-count">{total - ids.filter((id) => p.skip.has(id)).length} of {total}</span></h2>
        <button type="button" className="ss-link-btn" onClick={() => p.onSkipAll(ids, allOn)}>{allOn ? "Leave all out" : "Copy all"}</button>
      </div>
      <p className="ss-cmp-hint">In the order the sync types them. Click one to see it on both pages.</p>
      {tabs.map((tab) => {
        const shown = all[tab.rightTabId] ? tab.changes : tab.changes.slice(0, SHOWN);
        return (
          <div key={tab.rightTabId} className="ss-cmp-group">
            {many && <h3 className="ss-cmp-h3">{tab.rightTitle}</h3>}
            <ul className="ss-cmp-changes">
              {shown.map((c) => {
                const off = p.skip.has(c.id);
                const title = changeTitle(c);
                return (
                  <li key={c.id} className="ss-cmp-change" data-off={off ? "true" : undefined} data-active={p.activeChange === c.id ? "true" : undefined}>
                    <button type="button" className="ss-cmp-change-main" onClick={() => p.onJump(c)} aria-label={`${CHANGE_LABEL[c.kind]}: ${title}. ${c.where}. Show it on the pages`}>
                      <span className="ss-cmp-kind" aria-hidden="true">{KIND_ICON[c.kind]}</span>
                      <span className="min-w-0 flex-1">
                        <span className="ss-cmp-change-text">{c.kind === "text" || c.kind === "paragraph" || c.kind === "list" || c.kind === "cell" ? <>&ldquo;{title}&rdquo;</> : title}</span>
                        <span className="ss-cmp-change-where">
                          {CHANGE_LABEL[c.kind]} · {c.where}{c.words > 0 ? ` · ${plural(c.words, "word")}` : ""}{c.when === "start" ? " · set up first" : ""}
                        </span>
                      </span>
                    </button>
                    <label className="ss-cmp-toggle" title={off ? "Left out. Click to copy it" : "Copied. Click to leave it out"}>
                      <input type="checkbox" checked={!off} onChange={() => p.onToggleSkip(c.id)} aria-label={`Copy ${title}`} />
                      <span className="ss-cmp-toggle-track" aria-hidden="true"><span className="ss-cmp-toggle-thumb" /></span>
                    </label>
                  </li>
                );
              })}
            </ul>
            {tab.changes.length > SHOWN && (
              <button type="button" className="ss-side-more ml-0" onClick={() => setAll((a) => ({ ...a, [tab.rightTabId]: !a[tab.rightTabId] }))}>
                {all[tab.rightTabId] ? "Show fewer" : `Show all ${tab.changes.length}`}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Kept and can't-copy lines, summed across tabs, one per kind */
function merge<T extends { kind: string; count: number; sample?: string }>(list: T[]): T[] {
  const by = new Map<string, T>();
  for (const x of list) {
    const k = x.kind + ((x as { asText?: boolean }).asText ? ":t" : "");
    const cur = by.get(k);
    by.set(k, cur ? { ...cur, count: cur.count + x.count, sample: cur.sample ?? x.sample } : { ...x });
  }
  return [...by.values()];
}

function LeftAlone({ result }: { result: CompareResult }) {
  const [open, setOpen] = useState(false);
  const kept = merge<Kept>(result.tabs.flatMap((t) => t.kept).filter((k) => k.kind !== "leftTab"));
  const cant = merge<Unsupported>(result.tabs.flatMap((t) => t.unsupported));
  if (!kept.length && !cant.length) return null;
  const n = kept.length + cant.length;
  return (
    <section className="ss-cmp-section">
      <button type="button" className="ss-cmp-disclose" aria-expanded={open} aria-controls="ss-cmp-alone" onClick={() => setOpen((o) => !o)}>
        <span className="ss-cmp-h2">Left as it is <span className="ss-cmp-count">{n}</span></span>
        <Icon name="keyboard_arrow_down" className={`ss-cmp-chevron ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id="ss-cmp-alone" key="alone" className="overflow-hidden" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease }}>
            <p className="ss-cmp-hint">Nothing in your document is deleted, moved or restyled.</p>
            {kept.length > 0 && (
              <ul className="ss-cmp-alone">
                {kept.map((k) => <li key={k.kind}><Icon name="check" size={16} className="ss-cmp-alone-icon" /><span>{keptLine(k)}{k.sample ? <span className="ss-cmp-sample">For example &ldquo;{k.sample}&rdquo;</span> : null}</span></li>)}
              </ul>
            )}
            {cant.length > 0 && (
              <>
                <h3 className="ss-cmp-h3">Can&apos;t be copied</h3>
                <ul className="ss-cmp-alone">
                  {cant.map((u) => <li key={u.kind + (u.asText ? "t" : "")}><Icon name="remove" size={16} className="ss-cmp-alone-icon" /><span>{unsupportedLine(u)}{u.sample ? <span className="ss-cmp-sample">For example &ldquo;{u.sample}&rdquo;</span> : null}</span></li>)}
                </ul>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function Settings(p: ComparePanelProps) {
  const s = p.settings;
  const typoIdx = TYPO_OPTIONS.reduce((best, o, i) => (Math.abs(o.value - s.typoFrequency) < Math.abs(TYPO_OPTIONS[best].value - s.typoFrequency) ? i : best), 0);
  const startAt = Date.now() + s.startInMinutes * 60_000;
  const off = p.starting;
  return (
    <section className="ss-cmp-section flex flex-col gap-4" aria-labelledby="ss-cmp-settings">
      <h2 id="ss-cmp-settings" className="ss-cmp-h2">Sync settings</h2>
      {s.breaksMode !== "manual" && (
        <div>
          <label className="ss-field-label" htmlFor="ss-cmp-duration">Total time</label>
          <select id="ss-cmp-duration" className="ss-select" disabled={off} value={s.durationMinutes ?? ""} onChange={(e) => p.onSettings({ durationMinutes: e.target.value === "" ? null : Number(e.target.value) })}>
            {DURATION_OPTIONS.map((m) => <option key={m ?? "auto"} value={m ?? ""}>{m == null ? "Natural pace" : formatSpan(m)}</option>)}
          </select>
          <p className="ss-field-help">
            {s.durationMinutes == null ? "About 35 words a minute, with short pauses." : s.breaksMode === "auto" ? "Speed varies a little and breaks fill the rest." : "Typing speeds up or slows down to fit."}
          </p>
        </div>
      )}
      <div>
        <span className="ss-field-label" id="ss-cmp-breaks-label">Breaks</span>
        <div className="ss-segmented" role="group" aria-labelledby="ss-cmp-breaks-label">
          {([["auto", "Automatic"], ["none", "None"], ["manual", "Manual"]] as const).map(([v, label]) => (
            <button key={v} type="button" aria-pressed={s.breaksMode === v} disabled={off} onClick={() => p.onSettings({ breaksMode: v })}>
              {s.breaksMode === v && <motion.span layoutId="ss-cmp-breaks-pill" className="ss-seg-pill" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
              <span className="ss-seg-label">{label}</span>
            </button>
          ))}
        </div>
        {s.breaksMode === "manual" ? <ManualBreaks {...p} /> : (
          <p className="ss-field-help">{s.breaksMode === "auto" ? "A few longer pauses, based on how much there is to type." : "Only short pauses between sentences."}</p>
        )}
      </div>
      <div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="ss-field-label" htmlFor="ss-cmp-typos">Typos</label>
            <select id="ss-cmp-typos" className="ss-select" disabled={off} value={typoIdx} onChange={(e) => p.onSettings({ typoFrequency: TYPO_OPTIONS[Number(e.target.value)].value })}>
              {TYPO_OPTIONS.map((o, i) => <option key={o.label} value={i}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="ss-field-label" htmlFor="ss-cmp-start">Start</label>
            <select id="ss-cmp-start" className="ss-select" disabled={off} value={s.startInMinutes} onChange={(e) => p.onSettings({ startInMinutes: Number(e.target.value) })}>
              {START_OPTIONS.map((m) => <option key={m} value={m}>{m === 0 ? "Right away" : `In ${formatSpan(m)}`}</option>)}
            </select>
          </div>
        </div>
        <p className="ss-field-help">{s.startInMinutes === 0 ? "Runs on our server, so you can close this tab." : `Starts at ${formatClock(startAt)}, even if this tab is closed.`}</p>
      </div>
    </section>
  );
}

function ManualBreaks(p: ComparePanelProps) {
  const m = p.manual;
  const minutes = parseBreakLength(p.settings.breakLength);
  const typed = p.settings.breakLength.trim().length > 0;
  return (
    <div className="mt-3">
      <p className="ss-field-help mb-3">Types at a natural pace, with a break after each word you mark{m.rows.length || m.elsewhere ? "." : ". None marked yet."}</p>
      <label className="ss-field-label" htmlFor="ss-break-length">Break length</label>
      <div className="flex items-center gap-2">
        <input
          id="ss-break-length"
          className="ss-input min-w-0 flex-1"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. 33m"
          value={p.settings.breakLength}
          disabled={p.starting}
          aria-invalid={typed && minutes == null ? true : undefined}
          aria-describedby="ss-cmp-break-length-help"
          onChange={(e) => m.onLength(e.target.value)}
        />
        <button
          type="button"
          className={`ss-btn ${m.placing ? "ss-btn-tonal" : "ss-btn-outlined"} flex-none px-4`}
          aria-pressed={m.placing}
          disabled={p.starting || minutes == null || (!m.placing && !m.canPlace)}
          onClick={m.onTogglePlacing}
        >
          Place on page
        </button>
      </div>
      <p id="ss-cmp-break-length-help" className="ss-field-help" data-error={typed && minutes == null ? "true" : undefined}>
        {minutes == null
          ? typed ? "Try 33m or 1h 5m." : "Type a length, then click a glowing word in your document."
          : m.placing
            ? <><span className="text-[var(--ss-text)]">{describeBreak(minutes)}.</span> Click a glowing word in your document: the break starts after it.</>
            : m.canPlace
              ? <><span className="text-[var(--ss-text)]">{describeBreak(minutes)}.</span> Press Place on page, then click a glowing word.</>
              : <><span className="text-[var(--ss-text)]">{describeBreak(minutes)}.</span> Nothing new is typed in this tab, so it has no word to break after.</>}
      </p>
      {m.rows.length > 0 && (
        <>
          <ul className="ss-brk-list" aria-label="Breaks in this tab">
            <AnimatePresence initial={false}>
              {m.rows.map((b) => (
                <motion.li
                  key={b.id ?? `${b.from}-${b.to}`}
                  layout="position"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18, ease }}
                  onMouseEnter={() => m.onHover(b)}
                  onMouseLeave={() => m.onHover(null)}
                >
                  <button type="button" className="ss-brk-row" onClick={() => m.onJump(b)} title="Show it on the page">
                    <span className="ss-brk-chip">{formatBreak(b.minutes)}</span>
                    <span className="truncate">after &ldquo;{b.word}&rdquo;</span>
                  </button>
                  <button type="button" className="ss-icon-btn ss-brk-remove" disabled={p.starting} onClick={() => m.onRemove(b)} aria-label={`Remove the ${formatBreak(b.minutes)} break after ${b.word}`} title="Remove">
                    <X className="h-4 w-4" />
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <div className="mt-1 flex items-center justify-between text-[12px] text-[var(--ss-text-2)]">
            <span>{plural(m.rows.length, "break")} in this tab{m.elsewhere ? `, ${m.elsewhere} in others` : ""}</span>
            <button type="button" className="ss-link-btn" disabled={p.starting} onClick={m.onClear}>Clear all</button>
          </div>
        </>
      )}
      {!m.rows.length && m.elsewhere > 0 && <p className="ss-field-help">{plural(m.elsewhere, "break")} in other tabs.</p>}
    </div>
  );
}

function StartCard(p: ComparePanelProps & { nothing: boolean }) {
  const plan = p.plan;
  const startAt = Date.now() + p.settings.startInMinutes * 60_000;
  const label = p.starting ? "Starting" : p.settings.startInMinutes > 0 ? "Schedule sync" : "Start sync";
  const disabled = p.starting || p.nothing || !!p.blocked;
  return (
    <div className="ss-cmp-start">
      <motion.section layout transition={{ duration: 0.25, ease }} className="rounded-xl bg-[var(--ss-soft)] p-4" aria-live="polite">
        {plan && !p.nothing ? (
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[22px] leading-7">{formatSpan(plan.totalMs / 60_000)}</div>
              <div className="text-[14px] text-[var(--ss-text-2)]">Finishes around {formatClock(startAt + plan.totalMs)}</div>
            </div>
            <button type="button" className="ss-icon-btn h-9 w-9 rounded-full" onClick={p.onShuffle} disabled={p.starting} title="Try a different schedule" aria-label="Try a different schedule">
              <Shuffle className="h-[18px] w-[18px]" />
            </button>
          </div>
        ) : (
          <p className="text-[14px] text-[var(--ss-text-2)]">{p.nothing ? "There's nothing to type." : "Working out how long it takes."}</p>
        )}
        {plan && !p.nothing && plan.targetMs != null && !plan.fitsTarget && (
          <p className="mt-3 rounded-lg bg-[#fef7e0] px-3 py-2 text-[13px] leading-5 text-[#5c4300]">
            {plan.totalMs < plan.targetMs
              ? `This can't be stretched to ${formatSpan(plan.targetMs / 60_000)} ${p.settings.breaksMode === "none" ? "without breaks" : "with these breaks"}. Choose automatic breaks to fill the time, or pick a shorter total.`
              : `These breaks alone take longer than ${formatSpan(plan.targetMs / 60_000)}. Remove a break or pick a longer total.`}
          </p>
        )}
        <AnimatePresence initial={false}>
          {p.startError && (
            <motion.p key="err" role="alert" className="mt-3 overflow-hidden rounded-lg bg-[#fce8e6] px-3 py-2 text-[13px] leading-5 text-[#8c1d18]" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease }}>
              {p.startError}
            </motion.p>
          )}
        </AnimatePresence>
        <button type="button" className="ss-btn ss-btn-filled mt-3 w-full" onClick={p.onStart} disabled={disabled} title={p.blocked ?? (p.nothing ? "Nothing to copy" : label)}>
          {p.starting ? <span className="ss-cmp-spinner ss-cmp-spinner-light" aria-hidden="true" /> : <Icon name="play_arrow" />}
          {label}
        </button>
        {p.blocked && <p className="ss-field-help mt-2 text-center">{p.blocked}</p>}
      </motion.section>
    </div>
  );
}
