/*!
 * DevLaunch Growth Engine - Chatwoot live-chat widget loader.
 *
 * A thin wrapper around Chatwoot's OWN documented embed pattern (its
 * `sdk.js` + `window.chatwootSDK.run({ websiteToken, baseUrl })` call —
 * verified directly against the Chatwoot source's widget bundle entry
 * point in the reference clone, ~/project/Growth/chatwoot, read-only).
 * This file does NOT reimplement any chat UI itself (unlike chatbot.js,
 * which renders platform's own in-house deterministic lead-capture bot) —
 * Chatwoot's widget is a separate, fully-featured live-agent chat product
 * (see docs/OPEN_SOURCE_INTEGRATION_AUDIT.md's "chatwoot" section); the
 * two can run on the same page side by side, deliberately uncoupled.
 *
 * DESIGN CHOICE (documented per this feature's task instructions): the
 * websiteToken/baseUrl are read directly from this script tag's data
 * attributes rather than fetched from a platform API at runtime. Reasons:
 *   1. A Chatwoot website token is the PUBLIC half of its widget identity
 *      (meant to be visible in page source — this is Chatwoot's own
 *      documented pattern), so there is no confidentiality reason to
 *      proxy it through an extra platform API call.
 *   2. It avoids adding a second public, unauthenticated platform
 *      endpoint purely to hand back two already-public strings — smaller
 *      attack surface than packages/embed-widget/embed.js's config fetch
 *      needed when it was guarding something NOT safe to hardcode (a
 *      qualifying question/booking link that doubles as light config).
 *   3. It matches Chatwoot's own normal integration instructions exactly,
 *      so a tenant copy-pasting Chatwoot's native embed snippet (e.g. from
 *      Chatwoot's own dashboard) "just works" the same way with no
 *      platform-specific adaptation needed.
 * Platform's dashboard (apps/dashboard/src/pages/ChatwootIntegrationPage.tsx)
 * surfaces the exact ready-to-paste `<script>` block (also obtainable via
 * GET .../integrations/chatwoot/embed-snippet) that sets these attributes
 * for the tenant, rather than this file fetching them itself.
 *
 * Usage: paste
 *   <script src=".../chatwootWidget.js" defer
 *           data-base-url="https://chat.yourcompany.example"
 *           data-website-token="abc123"></script>
 * on any page of an external website.
 *
 * Identity verification (Milestone 3, Phase 1 — ADDITIVE, not a
 * replacement): the anonymous-visitor path above (no data-identifier
 * attribute) is UNCHANGED and remains the default for public marketing-site
 * embeds, same audience as embed.js/chatbot.js. This loader now ALSO
 * supports an opt-in authenticated-identity path for pages where the
 * visitor is already a signed-in platform user (e.g. an in-app support
 * chat surface): if the script tag carries BOTH `data-identifier` and
 * `data-identifier-hash` (obtained server-side from this tenant's
 * authenticated
 * GET .../integrations/chatwoot/identity-hash — see
 * apps/api/src/lib/chatwootIdentity.ts for the exact HMAC-SHA256 scheme,
 * confirmed against Chatwoot's own reference source), this loader calls
 * Chatwoot's own documented `window.$chatwoot.setUser(identifier, {
 * identifier_hash })` after the SDK's own `chatwoot:ready` event fires
 * (`app/javascript/widget/constants/sdkEvents.js`'s `CHATWOOT_READY` in the
 * reference clone) — exactly Chatwoot's own documented identity-validation
 * flow, not a platform reimplementation of it. `identifier`/
 * `identifier-hash` are both required together; either one alone is
 * ignored (fails closed to the existing anonymous path) rather than
 * calling setUser with a hash Chatwoot would reject anyway.
 */
(function () {
  "use strict";

  function findScriptTags() {
    var scripts = Array.prototype.slice.call(
      document.querySelectorAll("script[data-website-token][src*='chatwootWidget.js']"),
    );
    if (scripts.length === 0 && document.currentScript && document.currentScript.getAttribute("data-website-token")) {
      scripts = [document.currentScript];
    }
    return scripts;
  }

  function loadWidget(scriptEl) {
    var baseUrl = (scriptEl.getAttribute("data-base-url") || "").replace(/\/$/, "");
    var websiteToken = scriptEl.getAttribute("data-website-token");
    var launcherTitle = scriptEl.getAttribute("data-launcher-title") || undefined;
    // Opt-in authenticated-identity attrs (both required together — see
    // this file's header doc comment). Obtained server-side from
    // GET .../integrations/chatwoot/identity-hash, never computed
    // client-side (the HMAC token itself must never reach the browser).
    var identifier = scriptEl.getAttribute("data-identifier");
    var identifierHash = scriptEl.getAttribute("data-identifier-hash");
    var userEmail = scriptEl.getAttribute("data-user-email") || undefined;
    var userName = scriptEl.getAttribute("data-user-name") || undefined;

    if (!baseUrl || !websiteToken) {
      return; // misconfigured -- fail silently, same convention as embed.js/chatbot.js
    }

    // Chatwoot's own documented settings object, read by sdk.js before
    // chatwootSDK.run() is called -- optional, only set when provided.
    if (launcherTitle) {
      window.chatwootSettings = window.chatwootSettings || {};
      if (!window.chatwootSettings.launcherTitle) {
        window.chatwootSettings.launcherTitle = launcherTitle;
      }
    }

    var g = document.createElement("script");
    var s = document.getElementsByTagName("script")[0];
    g.src = baseUrl + "/packs/js/sdk.js";
    g.defer = true;
    g.async = true;
    g.onload = function () {
      if (window.chatwootSDK && typeof window.chatwootSDK.run === "function") {
        window.chatwootSDK.run({ websiteToken: websiteToken, baseUrl: baseUrl });

        // identifier + identifier_hash required TOGETHER -- see this
        // file's header doc comment. Wait for Chatwoot's own
        // 'chatwoot:ready' event (fired once the widget iframe has
        // actually initialized) before calling setUser, exactly as
        // Chatwoot's own identity-validation docs instruct -- calling it
        // any earlier is a documented Chatwoot footgun (the iframe isn't
        // listening yet).
        if (identifier && identifierHash) {
          window.addEventListener("chatwoot:ready", function onReady() {
            window.removeEventListener("chatwoot:ready", onReady);
            if (window.$chatwoot && typeof window.$chatwoot.setUser === "function") {
              window.$chatwoot.setUser(identifier, {
                email: userEmail,
                name: userName,
                identifier_hash: identifierHash,
              });
            }
          });
        }
      }
    };
    s.parentNode.insertBefore(g, s);
  }

  function init() {
    findScriptTags().forEach(loadWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
