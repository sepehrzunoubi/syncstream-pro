import type { Metadata } from "next";
import { ContactLine, LegalPage, type LegalSection } from "@/components/legal/legal-page";

export const metadata: Metadata = {
  title: "Privacy Policy · SyncStream",
  description: "What SyncStream accesses in your Google account, what it stores, and for how long.",
};

const UPDATED = "September 28, 2026";

const summary = (
  <ul>
    <li>SyncStream only opens the Google Docs you pick, to show them, save the edits you make, and type the text you add.</li>
    <li>A sync&apos;s text and a copy of your Google sign-in are stored while it runs, and deleted a week after its last activity, or as soon as you remove it.</li>
    <li>Drafts and unsynced text stay in your browser. No ads, no analytics, no selling data.</li>
  </ul>
);

const sections: LegalSection[] = [
  {
    id: "what-it-does",
    title: "What SyncStream does",
    body: (
      <p>
        SyncStream opens a Google Doc you choose so you can edit it, and types the text you add into it at a natural,
        human pace, with pauses and corrected typos. Syncs run on our server, so they keep going after you close the tab.
      </p>
    ),
  },
  {
    id: "google-access",
    title: "What we access in your Google account",
    body: (
      <>
        <p>When you sign in with Google, you grant SyncStream these permissions:</p>
        <ul>
          <li><strong>Your name, email address and profile photo,</strong> to show which account is signed in.</li>
          <li><strong>Google Docs,</strong> to read the document you pick, save your edits to it, and type your syncs into it.</li>
          <li><strong>Google Drive, read-only,</strong> to list your recent documents so you can pick one.</li>
          <li><strong>Files created with SyncStream,</strong> to create a new document when you ask for one.</li>
        </ul>
        <p>SyncStream only opens documents you pick. It never deletes files and never shares them.</p>
      </>
    ),
  },
  {
    id: "what-we-store",
    title: "What we store, and for how long",
    body: (
      <ul>
        <li>
          <strong>Your sign-in.</strong> Google&apos;s access token and refresh token are kept in secure, HTTP-only cookies in
          your browser. The refresh token cookie lasts up to 30 days. Signing out deletes them.
        </li>
        <li>
          <strong>Syncs.</strong> When you start a sync, we store the text to type and its formatting, its schedule, the
          document&apos;s ID and name, a copy of the document as it was for the progress view, and a copy of your Google tokens
          so the sync can run without your browser. All of it is deleted automatically 7 days after the sync&apos;s last activity,
          or right away when you remove the sync from your list.
        </li>
        <li>
          <strong>Images you add.</strong> Images you paste or upload are stored for 14 days at a private, hard-to-guess
          address, so Google Docs can fetch them when the sync reaches them.
        </li>
        <li>
          <strong>Your documents.</strong> When you open a document, its content passes through our server to your browser.
          We don&apos;t keep it, except the copy stored with a sync you start.
        </li>
        <li>
          <strong>On your device.</strong> Drafts, settings and text you haven&apos;t synced yet are kept in your
          browser&apos;s storage. They leave your device only when you start a sync.
        </li>
      </ul>
    ),
  },
  {
    id: "how-we-use",
    title: "How we use it",
    body: (
      <>
        <p>
          We use this information only to run SyncStream for you. We don&apos;t sell it, use it for advertising, share it
          with anyone who isn&apos;t running the service, or use it to train AI models.
        </p>
        <p>
          SyncStream&apos;s use and transfer of information received from Google APIs adheres to the{" "}
          <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Services we rely on",
    body: (
      <ul>
        <li><strong>Google</strong> for sign-in and the Docs and Drive APIs.</li>
        <li><strong>Vercel</strong> hosts the app and its server.</li>
        <li><strong>Upstash</strong> stores syncs (Redis) and schedules their next steps (QStash). Scheduled messages carry only a sync&apos;s ID.</li>
      </ul>
    ),
  },
  {
    id: "cookies",
    title: "Cookies",
    body: <p>SyncStream uses only the sign-in cookies above. There are no analytics, tracking or advertising cookies.</p>,
  },
  {
    id: "choices",
    title: "Your choices",
    body: (
      <ul>
        <li>Remove a sync from your list to delete everything stored for it.</li>
        <li>Sign out from the account menu to delete the sign-in cookies.</li>
        <li>
          Revoke SyncStream&apos;s access at any time in your{" "}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">Google Account permissions</a>.
          Running syncs then stop.
        </li>
        <li>Clear this site&apos;s data in your browser to delete drafts and unsynced text.</li>
      </ul>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        Everything travels over HTTPS. Tokens are kept in HTTP-only cookies your browser&apos;s scripts can&apos;t read, and on
        the server only while a sync needs them. Every sync is tied to your Google account, and only you can see or
        control it.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: <p>SyncStream isn&apos;t meant for children under 13, and we don&apos;t knowingly collect their information.</p>,
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: <p>If this policy changes, we&apos;ll update it here and change the date at the top.</p>,
  },
  {
    id: "contact",
    title: "Contact",
    body: <ContactLine />,
  },
];

export default function PrivacyPolicyPage() {
  return <LegalPage kind="privacy" title="Privacy Policy" updated={UPDATED} summary={summary} sections={sections} />;
}
