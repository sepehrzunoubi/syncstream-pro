"use client";

import React from "react";
import { motion } from "framer-motion";
import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";

export default function TermsOfServicePage() {
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
            <FileText className="w-5 h-5 text-blue-400" />
          </div>
          <h1 className="text-2xl md:text-3xl font-semibold text-white tracking-tight">
            Terms of Service
          </h1>
        </div>
        <p className="text-sm text-zinc-600 mb-10">
          Last updated: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>

        {/* Sections */}
        <div className="space-y-8 text-[14px] leading-relaxed text-zinc-400">
          <Section title="1. Acceptance of Terms">
            <p>
              By accessing or using SyncStream (&quot;the Service&quot;), you agree to be bound by these
              Terms of Service. If you do not agree to these terms, you may not use the Service.
              These terms constitute a legally binding agreement between you and SyncStream.
            </p>
          </Section>

          <Section title="2. Description of Service">
            <p>
              SyncStream is a document synchronization tool that enables human-cadence text input
              into Google Docs via the Google Docs API. The Service requires a valid Google account
              to operate.
            </p>
          </Section>

          <Section title="3. Acceptable Use">
            <p className="mb-3">You agree not to:</p>
            <ul className="list-disc list-inside space-y-1.5 text-zinc-500">
              <li>Attempt to reverse-engineer, decompile, or tamper with the Service.</li>
              <li>Circumvent or bypass authentication or any security measures.</li>
              <li>Use the Service for any illegal or unauthorized purpose.</li>
              <li>Interfere with or disrupt the integrity or performance of the Service.</li>
              <li>Share your account credentials with unauthorized third parties.</li>
              <li>Automate access to the Service beyond its intended functionality.</li>
            </ul>
          </Section>

          <Section title="4. Google Account & API Usage">
            <p>
              SyncStream accesses your Google account through OAuth 2.0 with the minimum required
              scopes. By using the Service, you authorize SyncStream to read and write to Google Docs
              and access Google Drive file listings on your behalf. You may revoke this access at any
              time through your{" "}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
              >
                Google Account settings
              </a>
              . Revoking access will prevent SyncStream from functioning until re-authorized.
            </p>
          </Section>

          <Section title="5. Intellectual Property">
            <p>
              The Service, including its design, code, and branding, is the intellectual property of
              SyncStream. You are granted a limited, non-exclusive, non-transferable license to use
              the Service in accordance with these terms. You do not acquire any ownership rights by
              using the Service.
            </p>
          </Section>

          <Section title="6. Disclaimer of Warranties">
            <p>
              The Service is provided <strong className="text-zinc-300">&quot;as is&quot;</strong> and{" "}
              <strong className="text-zinc-300">&quot;as available&quot;</strong> without warranties of any kind,
              whether express or implied, including but not limited to warranties of merchantability,
              fitness for a particular purpose, or non-infringement. We do not guarantee uninterrupted
              or error-free operation of the Service.
            </p>
          </Section>

          <Section title="7. Limitation of Liability">
            <p>
              To the maximum extent permitted by law, SyncStream and its operators shall not be liable
              for any indirect, incidental, special, consequential, or punitive damages, or any loss
              of profits or revenues, whether incurred directly or indirectly, arising from your use
              of the Service. Our total liability shall not exceed the amount, if any, paid by you
              for the Service.
            </p>
          </Section>

          <Section title="8. Termination">
            <p>
              We reserve the right to suspend or terminate your access to the Service at any time,
              with or without notice, for conduct that we believe violates these terms or is harmful
              to the Service, other users, or third parties. Upon termination, any data associated
              with your account may be deleted.
            </p>
          </Section>

          <Section title="9. Modifications">
            <p>
              We may revise these Terms of Service at any time. Changes will be posted on this page
              with an updated date. Your continued use of the Service after any changes constitutes
              acceptance of the new terms.
            </p>
          </Section>

          <Section title="10. Governing Law">
            <p>
              These terms shall be governed by and construed in accordance with applicable laws,
              without regard to conflict of law principles. Any disputes arising from these terms
              shall be resolved through good-faith negotiation before pursuing formal legal action.
            </p>
          </Section>

          <Section title="11. Contact">
            <p>
              If you have questions about these Terms of Service, please reach out to us through
              our official communication channels.
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
