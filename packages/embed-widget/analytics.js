/*!
 * DevLaunch Growth Engine - first-party website analytics tracking snippet.
 *
 * A SEPARATE file from embed.js (the lead-capture <form> widget) and
 * chatbot.js (the AI chat bubble) -- this one is the GENERAL-PURPOSE
 * visitor/session/pageview tracker. Same conventions as those two: vanilla
 * JS, no build step, no framework, no dependencies, fails silently if
 * misconfigured.
 *
 * Usage: paste
 *   <script src=".../analytics.js" defer
 *           data-api-base="https://api.yoursite.example"
 *           data-project-key="pk_..."></script>
 * on every page of a tracked website (apps/api/src/routes/publicAnalytics.ts
 * is the server side of this, same per-project PUBLIC key + Origin
 * allowlist model as embed.js/chatbot.js).
 *
 * What it does:
 *   - Generates (or reads) a persistent, anonymous, opaque visitor id,
 *     stored in localStorage (so it survives across sessions/tabs on the
 *     same browser) -- never anything that identifies a real person on its
 *     own (no email, no fingerprinting).
 *   - Generates (or reads) a session id, stored in sessionStorage with a
 *     30-minute-inactivity timeout tracked alongside it: if more than 30
 *     minutes have passed since the last beacon, a new session starts.
 *   - On load, sends one real `pageview` beacon (current URL/path,
 *     document.referrer, and any utm_* query params) to
 *     POST {api-base}/api/v1/public/projects/{key}/analytics/collect.
 *   - Exposes `window.devlaunchAnalytics.track(eventName, properties)` for
 *     any page (a landing page, this script's own page, anything) to fire
 *     a real custom event beacon (e.g. `form_submitted`).
 *   - Exposes `window.devlaunchAnalytics.pageview()` for single-page apps
 *     to report a route change as a new pageview without a full reload.
 *
 * CONSENT (read this before relying on it for compliance -- this is a real
 * technical control, NOT legal advice): the default posture is
 * "legitimate-interest analytics, but honor the browser's Do-Not-Track
 * signal" -- i.e. it tracks by default (anonymous, aggregate website
 * analytics is commonly treated as a lower-risk legitimate interest than
 * e.g. ad targeting), EXCEPT:
 *   - when the browser sends navigator.doNotTrack === "1" (or the legacy
 *     window.doNotTrack / navigator.msDoNotTrack equivalents), in which
 *     case NO beacon is ever sent, automatically, with no code change
 *     needed by the embedding site; or
 *   - when the visitor (or the embedding site, on the visitor's behalf,
 *     e.g. after a cookie-consent banner) has called
 *     `window.devlaunchAnalytics.optOut()`, which sets a localStorage flag
 *     this snippet checks before every single beacon, from then on, on
 *     that browser, until `optIn()` is called.
 * A site operating under a stricter regime (e.g. requiring opt-in consent
 * before any tracking at all) should call `optOut()` itself on page load by
 * default, and only call `optIn()` once the visitor has actually consented
 * -- this snippet supports either model; it does not decide the site's
 * legal posture for it.
 */
(function () {
  "use strict";

  var VISITOR_ID_KEY = "devlaunch_visitor_id";
  var SESSION_ID_KEY = "devlaunch_session_id";
  var SESSION_LAST_ACTIVITY_KEY = "devlaunch_session_last_activity";
  var OPT_OUT_KEY = "devlaunch_analytics_opt_out";
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity
  var UTM_PARAM_NAMES = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // Private browsing / blocked storage: tracking simply can't persist
      // across page loads on this browser. Never throw.
    }
  }

  function safeSessionStorageGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeSessionStorageSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (e) {
      // ignore
    }
  }

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    // Fallback for older browsers: not cryptographically strong, but this is
    // an opaque analytics correlation token, not a security credential.
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2) +
      Math.random().toString(36).slice(2)
    );
  }

  function hasDoNotTrack() {
    try {
      var dnt = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
      return dnt === "1" || dnt === "yes";
    } catch (e) {
      return false;
    }
  }

  function hasOptedOut() {
    return safeLocalStorageGet(OPT_OUT_KEY) === "1";
  }

  function optOut() {
    safeLocalStorageSet(OPT_OUT_KEY, "1");
  }

  function optIn() {
    try {
      window.localStorage.removeItem(OPT_OUT_KEY);
    } catch (e) {
      // ignore
    }
  }

  function canTrack() {
    return !hasDoNotTrack() && !hasOptedOut();
  }

  function getVisitorId() {
    var existing = safeLocalStorageGet(VISITOR_ID_KEY);
    if (existing) return existing;
    var fresh = randomId();
    safeLocalStorageSet(VISITOR_ID_KEY, fresh);
    return fresh;
  }

  // 30-minute-inactivity session scheme: a session id persists in
  // sessionStorage (so it's naturally scoped to one tab) alongside a
  // last-activity timestamp; any call to getSessionId() that finds the
  // timestamp older than SESSION_TIMEOUT_MS starts a brand new session
  // (new id), exactly like a real analytics session-timeout model.
  function getSessionId() {
    var now = Date.now();
    var existingId = safeSessionStorageGet(SESSION_ID_KEY);
    var lastActivityRaw = safeSessionStorageGet(SESSION_LAST_ACTIVITY_KEY);
    var lastActivity = lastActivityRaw ? parseInt(lastActivityRaw, 10) : 0;

    var expired = !existingId || !lastActivity || now - lastActivity > SESSION_TIMEOUT_MS;
    var sessionId = expired ? randomId() : existingId;

    safeSessionStorageSet(SESSION_ID_KEY, sessionId);
    safeSessionStorageSet(SESSION_LAST_ACTIVITY_KEY, String(now));

    return sessionId;
  }

  function getUtmParams() {
    var utm = {};
    try {
      var params = new URLSearchParams(window.location.search || "");
      UTM_PARAM_NAMES.forEach(function (name) {
        var value = params.get(name);
        if (value) {
          var camel = name.replace(/_([a-z])/g, function (_, c) {
            return c.toUpperCase();
          });
          utm[camel] = value;
        }
      });
    } catch (e) {
      // ignore malformed query string
    }
    return utm;
  }

  function buildClient(scriptEl) {
    var apiBase = (scriptEl.getAttribute("data-api-base") || "").replace(/\/$/, "");
    var projectKey = scriptEl.getAttribute("data-project-key");
    var configured = Boolean(apiBase && projectKey);

    function send(payload) {
      if (!configured || !canTrack()) return;
      var body = JSON.stringify(payload);
      var url = apiBase + "/api/v1/public/projects/" + encodeURIComponent(projectKey) + "/analytics/collect";

      // navigator.sendBeacon survives page unload (important for the last
      // pageview of a session) but doesn't support custom headers; fall
      // back to fetch with keepalive where sendBeacon is unavailable.
      if (navigator.sendBeacon) {
        try {
          var blob = new Blob([body], { type: "application/json" });
          navigator.sendBeacon(url, blob);
          return;
        } catch (e) {
          // fall through to fetch
        }
      }
      try {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true,
        }).catch(function () {
          // Network error: a dropped analytics beacon must never surface
          // to the embedding page.
        });
      } catch (e) {
        // ignore
      }
    }

    function basePayload() {
      var utm = getUtmParams();
      return {
        visitorId: getVisitorId(),
        sessionId: getSessionId(),
        url: window.location.href,
        path: window.location.pathname,
        referrer: document.referrer || "",
        utmSource: utm.utmSource,
        utmMedium: utm.utmMedium,
        utmCampaign: utm.utmCampaign,
        utmTerm: utm.utmTerm,
        utmContent: utm.utmContent,
      };
    }

    function pageview() {
      var payload = basePayload();
      payload.type = "pageview";
      send(payload);
    }

    function track(eventName, properties) {
      if (!eventName || typeof eventName !== "string") return;
      var payload = basePayload();
      payload.type = "event";
      payload.eventName = eventName;
      payload.properties = properties && typeof properties === "object" ? properties : {};
      send(payload);
    }

    return {
      pageview: pageview,
      track: track,
      optOut: optOut,
      optIn: optIn,
      hasOptedOut: hasOptedOut,
      getVisitorId: getVisitorId,
      getSessionId: getSessionId,
      _configured: configured,
    };
  }

  function init() {
    var scripts = qsa("script[data-project-key][src*='analytics.js']");
    if (scripts.length === 0 && document.currentScript && document.currentScript.getAttribute("data-project-key")) {
      scripts = [document.currentScript];
    }
    if (scripts.length === 0) return;

    // Only one devlaunchAnalytics instance per page, built from the first
    // matching script tag -- realistically only one is ever expected.
    var client = buildClient(scripts[0]);
    window.devlaunchAnalytics = client;

    if (client._configured) {
      client.pageview();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
