import type { Metadata } from "next";
import { ContactLine, LegalPage, type LegalSection } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service · SyncStream",
  description: "The terms for using SyncStream.",
};

const UPDATED = "September 28, 2026";

const summary = (
  <ul>
    <li>Edits you make in SyncStream are saved to your real Google Doc right away; syncs type into it over time.</li>
    <li>You&apos;re responsible for how you use it, including the rules of your school, employer or anyone whose document it is.</li>
    <li>SyncStream is provided as is. Keep your own copies of anything important.</li>
  </ul>
);

const sections: LegalSection[] = [
  {
    id: "agreement",
    title: "Agreeing to these terms",
    body: (
      <p>
        By signing in to or using SyncStream, you agree to these terms and to the <a href="/privacy">Privacy Policy</a>.
        If you don&apos;t agree, don&apos;t use SyncStream.
      </p>
    ),
  },
  {
    id: "service",
    title: "What SyncStream does",
    body: (
      <>
        <p>SyncStream connects to your Google account so you can:</p>
        <ul>
          <li><strong>Edit a Google Doc.</strong> Formatting, deleting and restructuring existing text are saved to the document right away.</li>
          <li><strong>Add text with a sync.</strong> Text you add is typed into the document at a human pace, with pauses, breaks and corrected typos, on a schedule you choose.</li>
        </ul>
        <p>Syncs run on our server and continue after you close the tab, until they finish, you pause or cancel them, or they fail.</p>
      </>
    ),
  },
  {
    id: "account",
    title: "Your Google account and documents",
    body: (
      <ul>
        <li>You need a Google account, and your use of Google is governed by Google&apos;s own terms.</li>
        <li>Only use SyncStream with documents you&apos;re allowed to edit.</li>
        <li>
          Changes made through SyncStream happen in your real document. Google Docs keeps a version history (File &gt;
          Version history) you can use to restore earlier versions.
        </li>
        <li>You can revoke SyncStream&apos;s access at any time in your Google Account permissions.</li>
      </ul>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <p>You&apos;re responsible for how you use SyncStream and the text it types. In particular, you agree to:</p>
        <ul>
          <li>Follow the law, and the rules of your school, employer or anyone else whose document or work it is, including rules about disclosing how work was produced.</li>
          <li>Only type content you have the right to use.</li>
          <li>Not try to access other people&apos;s syncs or data, get around limits, or overload or disrupt the service.</li>
        </ul>
      </>
    ),
  },
  {
    id: "limits",
    title: "How reliable it is",
    body: (
      <p>
        SyncStream depends on Google, Vercel and Upstash. Syncs can be delayed, retried or stopped when one of them has a
        problem, when a document is changed in ways that make SyncStream lose its place, or when usage limits are reached.
        Finish times are estimates. We may pause or stop syncs that put the service at risk.
      </p>
    ),
  },
  {
    id: "content",
    title: "Your content",
    body: (
      <p>
        Your documents and text stay yours. You let SyncStream process them only as needed to run the service for you, as
        described in the <a href="/privacy">Privacy Policy</a>.
      </p>
    ),
  },
  {
    id: "warranty",
    title: "No warranty",
    body: (
      <p>
        SyncStream is provided &quot;as is&quot; and &quot;as available&quot;, without warranties of any kind, including that it
        will be uninterrupted, error-free, or that it will type or edit exactly as intended.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <p>
        To the extent the law allows, the people who run SyncStream aren&apos;t liable for indirect or consequential losses,
        or for lost data, grades, work or profits, arising from your use of SyncStream.
      </p>
    ),
  },
  {
    id: "ending",
    title: "Stopping",
    body: (
      <p>
        You can stop using SyncStream at any time by signing out and revoking its access. We may suspend access that breaks
        these terms.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: <p>If these terms change, we&apos;ll update them here and change the date at the top. Using SyncStream after that means you accept them.</p>,
  },
  {
    id: "contact",
    title: "Contact",
    body: <ContactLine />,
  },
];

export default function TermsPage() {
  return <LegalPage kind="terms" title="Terms of Service" updated={UPDATED} summary={summary} sections={sections} />;
}
