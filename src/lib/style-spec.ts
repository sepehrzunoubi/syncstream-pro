/**
 * The compiled style the app ships: the winning prompt strategy, the
 * fingerprint and rules it was built from, and the samples it draws
 * exemplars from. Produced by `npm run style:compile`, read here.
 */

import compiled from "../../style-data/solvely/compiled.json";
import type { Fingerprint, Rule, Sample } from "./fingerprint";
import { matchFingerprint, selectExemplars } from "./fingerprint";
import { candidateById, maxOutputTokens, revisionMessages, type Candidate } from "./style-candidates";
import type { ChatMessage } from "./llm";

export interface CompiledStyle {
  version: 1;
  name: string;
  builtAt: string;
  /** Which candidate won, and the lab run that showed it */
  candidateId: string;
  evaluation: { run: string; score: number; samples: number; model: string } | null;
  notes: string;
  fingerprint: Fingerprint;
  rules: Rule[];
  /** Samples available as exemplars at runtime */
  exemplars: Sample[];
}

const spec = compiled as unknown as CompiledStyle;

export function compiledStyle(): CompiledStyle {
  return spec;
}

/** False until the lab has compiled a style with samples */
export function styleReady(): boolean {
  return !!spec.fingerprint && spec.exemplars.length > 0 && !!candidateById(spec.candidateId);
}

export interface Built {
  messages: ChatMessage[];
  candidate: Candidate;
  maxTokens: number;
  temperature: number;
}

/** The messages for a user's text, under the compiled style */
export function buildRequest(text: string, style: CompiledStyle = spec): Built {
  const candidate = candidateById(style.candidateId);
  if (!candidate) throw new Error(`Unknown prompt candidate "${style.candidateId}"`);
  const exemplars = selectExemplars(style.exemplars, text, candidate.exemplars);
  const messages = candidate.build({ fingerprint: style.fingerprint, rules: style.rules, exemplars, notes: style.notes, text });
  return { messages, candidate, maxTokens: maxOutputTokens(text, style.fingerprint), temperature: candidate.temperature };
}

/** A second pass that pushes a draft toward the fingerprint, when it strayed */
export function buildRevision(text: string, draft: string, style: CompiledStyle = spec): Built | null {
  const base = buildRequest(text, style);
  const report = matchFingerprint(style.fingerprint, text, draft);
  const fixes = report.deviations.filter((d) => d.severity >= 0.25).slice(0, 5).map((d) => d.hint);
  if (!fixes.length) return null;
  return { ...base, messages: revisionMessages(base.messages, draft, fixes) };
}
