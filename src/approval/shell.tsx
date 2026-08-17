// The document chrome and the primitives every surface composes from.
//
// Kept separate from the routes (src/approval/dashboard.tsx) so the chrome
// carries no agent or Worker dependency: a page can be rendered and reviewed
// on its own, and a test can assert what a surface actually says.
//
// ChartRoom's rule holds here — one Card / Stat / Pill / Table set, reused.
// A page that styles its own div is how two screens start looking like two
// applications.

import type { ComponentChildren, VNode } from "preact";
import { render } from "preact-render-to-string";
import { fontLinks, styles } from "./theme";
import { Sidebar, type NavKey } from "./nav";
import { capabilitiesOf, type UserRecord } from "../lib/rbac";

export function html(node: VNode): Response {
  return new Response(`<!doctype html>${render(node)}`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Back to the operations panel after a mutation. */
export function redirectTo(fragment = ""): Response {
  return new Response(null, { status: 303, headers: { Location: `/approval/ops${fragment}` } });
}

/**
 * Mutating routes accept only same-origin submissions. The session cookie
 * would ride along on a cross-site form post; every Arcadia form is
 * same-origin, so anything else is rejected.
 */
export function rejectCrossOrigin(request: Request): Response | undefined {
  const url = new URL(request.url);
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  const origin = request.headers.get("Origin");
  const sameOrigin =
    (secFetchSite === null || secFetchSite === "same-origin" || secFetchSite === "none") &&
    (origin === null || origin === url.origin);
  return sameOrigin ? undefined : new Response("cross-origin form submission rejected", { status: 403 });
}

/** The identity line every page carries: who you are and what you may do. */
export function Whoami(props: { user: UserRecord }) {
  const { user } = props;
  return (
    <p class="who-row">
      <span class="tag role">{user.role}</span>
      <span class="tag">{user.displayName ?? user.email}</span>
      <span class="tag">{capabilitiesOf(user).length} capabilities</span>
      {user.leadEmail ? <span class="tag">lead {user.leadEmail}</span> : null}
    </p>
  );
}

/** A headline number. Tone is a verdict, never decoration. */
export function Stat(props: { label: string; value: string | number; note?: string; tone?: "ok" | "warn" | "danger" }) {
  const { label, value, note, tone } = props;
  return (
    <div class={tone ? `stat ${tone}` : "stat"}>
      <span class="k">{label}</span>
      <span class="v">{value}</span>
      {note ? <span class="n">{note}</span> : null}
    </div>
  );
}

/**
 * The status-bar pill: the state of whatever this page reports on. The dot
 * never carries the meaning alone — the label always says it too.
 */
export function Pill(props: { tone?: "ok" | "warn" | "danger" | "idle"; children: ComponentChildren }) {
  const { tone = "idle", children } = props;
  return (
    <span class={`pill ${tone}`}>
      <span class="dot" />
      {children}
    </span>
  );
}

/** The base surface. Pages compose from this rather than styling a div. */
export function Card(props: { title?: string; className?: string; children: ComponentChildren }) {
  const { title, className, children } = props;
  return (
    <section class={className ? `card ${className}` : "card"}>
      {title ? <h3>{title}</h3> : null}
      {children}
    </section>
  );
}

/**
 * Every page's document: rail, status bar, page heading, footer. One place to
 * change the chrome, so a new surface cannot ship with different navigation.
 *
 * `status` is a slot, not a fixture. A page with nothing to report there
 * renders no bar at all rather than an empty strip.
 */
export function Shell(props: {
  title: string;
  heading: string;
  user?: UserRecord;
  current?: NavKey;
  lede?: ComponentChildren;
  status?: ComponentChildren;
  children?: ComponentChildren;
}) {
  const { title, heading, user, current, lede, status, children } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <title>{title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <link rel="preconnect" href="https://cdn.fontshare.com" crossorigin="anonymous" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        {fontLinks.map((href) => (
          <link rel="stylesheet" href={href} />
        ))}
        {/* Not a text child: preact escapes those, and an escaped quote makes
            every font-family declaration in the sheet invalid. The stylesheet
            is a static string in this repo, never user input. */}
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <div class="app">
          {user ? <Sidebar user={user} {...(current ? { current } : {})} /> : null}
          <div class="content">
            {status ? <header class="topbar">{status}</header> : null}
            <main>
              <div class="wrap">
                <div class="pagehead">
                  <h1>{heading}</h1>
                  {lede ? <p class="lede">{lede}</p> : null}
                  {user ? <Whoami user={user} /> : null}
                </div>
                {children}
                <footer>
                  <span class="dot" />
                  Arcadia surfaces and attributes. Humans decide and sign.
                </footer>
              </div>
            </main>
          </div>
        </div>
      </body>
    </html>
  );
}
