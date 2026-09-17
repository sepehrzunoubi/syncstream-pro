"use client";

import React from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Shield } from "lucide-react";
import Link from "next/link";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#09090b] relative">
      {/* Top bar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.04] bg-[#09090b]/80 backdrop-blur-md">
        <div className="container mx-auto flex items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <img
              src="/sync-icon.png"
              alt="Sync"
              className="h-7 w-7 object-contain"
            />
            <span className="text-sm font-semibold text-white tracking-tight">
              SyncStream
            </span>
          </Link>
          <Link
            href="/"
            className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Link>
        </div>
      </nav>

      {/* Content */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="container mx-auto px-6 pt-28 pb-20 max-w-3xl"
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20">
            <Shield className="w-5 h-5 text-blue-400" />
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">
            Privacy Policy
          </h1>
        </div>
        <p className="text-sm text-zinc-600 mb-10">
          Last updated: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>

        {/* Sections */}
        <div className="space-y-8 text-[14px] leading-relaxed text-zinc-400">
          <Section title="1. Introduction">
            <p>
              SyncStream (&quot;we,&quot; &quot;our,&quot; or &quot;us&quot;) respects your privacy and is committed to
              protecting the personal information you share with us. This Privacy Policy describes how
              we collect, use, and safeguard your data when you use our service.
            </p>
          </Section>

          <Section title="2. Information We Collect">
            <p className="mb-3">When you use SyncStream, we may collect the following information:</p>
            <ul className="list-disc list-inside space-y-1.5 text-zinc-500">
              <li><strong className="text-zinc-300">Google Account Information</strong> — your name, email address, profile picture, and unique Google account identifier, obtained through Google OAuth 2.0.</li>
              <li><strong className="text-zinc-300">Usage Data</strong> — basic interaction data such as sync session metadata (document IDs, timestamps). We do not store the content of your documents.</li>
            </ul>
          </Section>

          <Section title="3. How We Use Your Information">
            <ul className="list-disc list-inside space-y-1.5 text-zinc-500">
              <li>To authenticate you via Google OAuth 2.0 and maintain your session.</li>
              <li>To provide the core SyncStream functionality (document synchronization).</li>
              <li>To enforce rate limits and prevent abuse of our service.</li>
            </ul>
          </Section>

          <Section title="4. Data Storage & Security">
            <p>
              Sync job state is stored securely using industry-standard encrypted storage (Upstash
              Redis with TLS encryption). We do not store your Google
              password — authentication is handled entirely by Google&apos;s OAuth 2.0 protocol. Access
              tokens are stored as httpOnly, secure cookies and are never exposed to client-side JavaScript.
            </p>
          </Section>

          <Section title="5. Third-Party Services">
            <p className="mb-3">SyncStream integrates with the following third-party services:</p>
            <ul className="list-disc list-inside space-y-1.5 text-zinc-500">
              <li><strong className="text-zinc-300">Google APIs</strong> — for authentication, Google Docs access, and Google Drive file listing. Subject to <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Google&apos;s Privacy Policy</a>.</li>
              <li><strong className="text-zinc-300">Upstash Redis</strong> — for secure, encrypted storage of in-progress sync job state.</li>
            </ul>
          </Section>

          <Section title="6. Data Retention">
            <p>
              Sync job state is retained only while a sync is in progress and expires automatically
              within 24 hours of completion. Session cookies expire automatically. You may request
              full data deletion by contacting us.
            </p>
          </Section>

          <Section title="7. Your Rights">
            <p className="mb-3">You have the right to:</p>
            <ul className="list-disc list-inside space-y-1.5 text-zinc-500">
              <li>Revoke SyncStream&apos;s access to your Google account at any time via your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline underline-offset-2">Google Account settings</a>.</li>
              <li>Request deletion of your data by contacting us.</li>
              <li>Access information about what data we store about you.</li>
            </ul>
          </Section>

          <Section title="8. Cookies">
            <p>
              SyncStream uses essential httpOnly cookies for authentication (<code className="text-zinc-300 bg-white/[0.04] px-1.5 py-0.5 rounded text-[12px]">google_access_token</code>,{" "}
              <code className="text-zinc-300 bg-white/[0.04] px-1.5 py-0.5 rounded text-[12px]">google_refresh_token</code>).
              We do not use tracking cookies, analytics cookies, or any third-party advertising cookies.
            </p>
          </Section>

          <Section title="9. Children's Privacy">
            <p>
              SyncStream is not directed at children under 13. We do not knowingly collect personal
              information from children under 13. If you believe we have collected such information,
              please contact us so we can delete it.
            </p>
          </Section>

          <Section title="10. Changes to This Policy">
            <p>
              We may update this Privacy Policy from time to time. Any changes will be reflected on
              this page with an updated &quot;Last updated&quot; date. Continued use of SyncStream after
              changes constitutes acceptance of the revised policy.
            </p>
          </Section>

          <Section title="11. Contact">
            <p>
              If you have questions about this Privacy Policy or your data, please reach out to us
              through our official communication channels.
            </p>
          </Section>
        </div>
      </motion.div>

      {/* Footer */}
      <footer className="border-t border-white/[0.04] py-8 relative z-10">
        <div className="container mx-auto px-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/sync-icon.png" alt="Sync" className="h-5 w-5 object-contain" />
            <span className="text-xs text-zinc-600">SyncStream</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Privacy</Link>
            <Link href="/tos" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-zinc-200 mb-3">{title}</h2>
      {children}
    </div>
  );
}
