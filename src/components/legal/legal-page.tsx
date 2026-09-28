"use client";

import React, { useEffect, useState } from "react";
import { motion } from "framer-motion";
import "./legal.css";

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

const FONTS = "https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500&family=Arimo:wght@400;700&display=swap";

/** A legal page laid out like a document: an outline on the left, the text on a page. */
export function LegalPage({
  kind,
  title,
  updated,
  summary,
  sections,
}: {
  kind: "privacy" | "terms";
  title: string;
  updated: string;
  summary: React.ReactNode;
  sections: LegalSection[];
}) {
  const [active, setActive] = useState(sections[0]?.id);

  // Highlight the section being read in the outline
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-88px 0px -60% 0px" }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections]);

  return (
    <div className="lg-root">
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href={FONTS} />
      <header className="lg-bar">
        <a href="/" className="lg-brand" aria-label="SyncStream home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sync-icon.png" alt="" />
          <span>SyncStream</span>
        </a>
        <nav className="lg-tabs" aria-label="Legal">
          <a className="lg-tab" href="/privacy" aria-current={kind === "privacy" ? "page" : undefined}>Privacy Policy</a>
          <a className="lg-tab" href="/tos" aria-current={kind === "terms" ? "page" : undefined}>Terms of Service</a>
        </nav>
        <a className="lg-open" href="/dashboard">Open SyncStream</a>
      </header>

      <div className="lg-body">
        <nav className="lg-outline" aria-label="On this page">
          <h2>Outline</h2>
          {sections.map((s) => (
            <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}>{s.title}</a>
          ))}
        </nav>
        <motion.article
          className="lg-sheet"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.2, 0, 0, 1] }}
        >
          <p className="lg-kicker">SyncStream</p>
          <h1>{title}</h1>
          <p className="lg-meta">Last updated {updated}</p>
          <aside className="lg-summary">
            <h2>In short</h2>
            {summary}
          </aside>
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="lg-section">
              <h2>{s.title}</h2>
              {s.body}
            </section>
          ))}
          <footer className="lg-foot">
            <span>SyncStream</span>
            <a href="/privacy">Privacy Policy</a>
            <a href="/tos">Terms of Service</a>
            <a href="/dashboard">Open SyncStream</a>
          </footer>
        </motion.article>
        <div className="lg-outline-spacer" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Where to reach whoever runs this deployment */
export function ContactLine() {
  const email = process.env.NEXT_PUBLIC_CONTACT_EMAIL;
  return email ? (
    <p>Questions or requests: email <a href={`mailto:${email}`}>{email}</a>.</p>
  ) : (
    <p>Questions or requests: email the support address shown on the Google sign-in screen when you connect SyncStream to your account.</p>
  );
}
