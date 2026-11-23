/*!
 * DevLaunch Growth Engine - embeddable lead-capture widget.
 *
 * Paste this as a <script src="...embed.js" defer></script> tag plus a
 * <form data-devlaunch-lead-form data-project-key="..."> on ANY external
 * website. No build step, no framework, no dependencies: plain vanilla JS
 * that progressively enhances a plain HTML <form>.
 *
 * What it does:
 *   - Finds every <form data-devlaunch-lead-form> on the page.
 *   - Fetches that project's public widget config (GET
 *     {data-api-base}/api/v1/public/projects/{data-project-key}/config) and,
 *     if the tenant configured one, renders a single extra qualifying
 *     question text input before the submit button.
 *   - On submit, collects fields named name/email/company/message, plus
 *     any other named field as a "custom field", plus the qualifying
 *     question's answer (if rendered), plus UTM params parsed from the
 *     current page URL and document.referrer.
 *   - POSTs them as JSON to
 *     {data-api-base}/api/v1/public/projects/{data-project-key}/leads
 *   - Shows a success/error message in an element the form already has
 *     (or one this script creates) — never navigates away or reloads. On
 *     success, if the project configured a booking link, shows a "Book a
 *     time" link alongside the thank-you message instead of just text.
 *
 * What it deliberately does NOT do: it never emails, calls, or messages
 * the lead itself, and it never talks to any third-party service. It only
 * ever creates one row via the project's lead-capture endpoint; a human +
 * the existing agent/approval flow decides what happens next.
 *
 * Security notes for the site owner:
 *   - data-project-key is a per-project PUBLIC key (safe to publish in
 *     page source) — it is NOT your DevLaunch login or any tenant secret.
 *   - The API only accepts submissions whose browser Origin is on that
 *     project's configured allowlist, so ask your DevLaunch admin to add
 *     this exact site's origin (e.g. https://www.your-site.com) before
 *     the form will work.
 */
(function () {
  "use strict";

  var UTM_PARAM_NAMES = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var QUALIFYING_ANSWER_FIELD_NAME = "devlaunch_qualifying_answer";
  var DEFAULT_THANK_YOU_MESSAGE = "Thanks! We'll be in touch.";

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function setMessage(form, message, isError) {
    // Build via textContent assignment (not innerHTML) so an error/status
    // string can never be interpreted as markup.
    var status = form.querySelector("[data-devlaunch-status]");
    if (!status) {
      status = document.createElement("div");
      status.setAttribute("data-devlaunch-status", "");
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    status.textContent = message;
    status.style.color = isError ? "#b00020" : "#1a7f37";
    status.style.marginTop = "8px";
    status.style.fontFamily = "sans-serif";
    status.style.fontSize = "14px";
  }

  // Renders the post-submit confirmation state. Uses a real <a> element
  // (not string-built innerHTML) for the booking link so the configured
  // URL is never interpreted as markup, while still allowing a clickable
  // link in the confirmation area.
  function showThankYou(form, config) {
    var status = form.querySelector("[data-devlaunch-status]");
    if (!status) {
      status = document.createElement("div");
      status.setAttribute("data-devlaunch-status", "");
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    status.textContent = "";
    status.style.color = "#1a7f37";
    status.style.marginTop = "8px";
    status.style.fontFamily = "sans-serif";
    status.style.fontSize = "14px";

    var message =
      (config && config.widgetThankYouMessage) ||
      form.getAttribute("data-success-message") ||
      DEFAULT_THANK_YOU_MESSAGE;

    var messageNode = document.createTextNode(message + " ");
    status.appendChild(messageNode);

    if (config && config.widgetBookingLinkUrl) {
      var link = document.createElement("a");
      link.href = config.widgetBookingLinkUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Book a time";
      status.appendChild(link);
    }
  }

  function getUtmAndReferrerFields() {
    var fields = {};
    try {
      var params = new URLSearchParams(window.location.search || "");
      UTM_PARAM_NAMES.forEach(function (name) {
        var value = params.get(name);
        if (value) {
          // utm_term -> utmTerm, etc.
          var camel = name.replace(/_([a-z])/g, function (_, c) {
            return c.toUpperCase();
          });
          fields[camel] = value;
        }
      });
    } catch (e) {
      // URLSearchParams unsupported / malformed query string: skip UTM capture.
    }
    try {
      if (document.referrer) {
        fields.referrerUrl = document.referrer;
      }
    } catch (e) {
      // ignore
    }
    return fields;
  }

  function collectFields(form) {
    var known = ["name", "email", "company", "message"];
    var payload = { customFields: {} };
    var formData = new FormData(form);

    formData.forEach(function (value, key) {
      if (typeof value !== "string") return; // skip File inputs
      if (key === QUALIFYING_ANSWER_FIELD_NAME) {
        payload.qualifyingAnswer = value;
      } else if (known.indexOf(key) !== -1) {
        payload[key] = value;
      } else {
        payload.customFields[key] = value;
      }
    });

    var utmAndReferrer = getUtmAndReferrerFields();
    for (var key2 in utmAndReferrer) {
      if (Object.prototype.hasOwnProperty.call(utmAndReferrer, key2)) {
        payload[key2] = utmAndReferrer[key2];
      }
    }

    // Milestone 2: if packages/embed-widget/analytics.js also happens to be
    // on this page (NEVER required -- this form works standalone exactly
    // as before if it isn't), pick up its visitor/session ids so this lead
    // can be correlated back to a tracked visitor session server-side (see
    // apps/api/src/lib/visitorLeadCorrelation.ts). A classic
    // "graceful if-present" integration: no hard dependency either way.
    try {
      if (window.devlaunchAnalytics && typeof window.devlaunchAnalytics.getVisitorId === "function") {
        payload.visitorId = window.devlaunchAnalytics.getVisitorId();
        payload.sessionId = window.devlaunchAnalytics.getSessionId();
      }
    } catch (e) {
      // ignore -- analytics snippet absent/misbehaving must never block a
      // lead submission.
    }

    return payload;
  }

  // Renders the one tenant-configured qualifying question as a plain text
  // input, inserted right before the submit button (or appended to the
  // form if no submit button is found). A no-op if the form has already
  // been enhanced, or if the project has no qualifying question configured.
  function renderQualifyingQuestion(form, question) {
    if (!question || form.querySelector('[name="' + QUALIFYING_ANSWER_FIELD_NAME + '"]')) return;

    var label = document.createElement("label");
    label.style.display = "block";
    label.style.marginBottom = "8px";
    label.style.fontFamily = "sans-serif";
    label.style.fontSize = "14px";

    var span = document.createElement("span");
    span.textContent = question;
    span.style.display = "block";
    span.style.marginBottom = "4px";

    var input = document.createElement("input");
    input.type = "text";
    input.name = QUALIFYING_ANSWER_FIELD_NAME;
    input.style.width = "100%";
    input.style.boxSizing = "border-box";

    label.appendChild(span);
    label.appendChild(input);

    var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
    if (submitButton) {
      form.insertBefore(label, submitButton);
    } else {
      form.appendChild(label);
    }
  }

  function fetchConfig(apiBase, projectKey) {
    return fetch(apiBase + "/api/v1/public/projects/" + encodeURIComponent(projectKey) + "/config", {
      method: "GET",
    })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        return body && body.config ? body.config : null;
      })
      .catch(function () {
        // Config fetch failing (network error, origin not yet allowlisted,
        // disabled project, etc.) must never block the form itself — it
        // just means no qualifying question / no booking link is shown.
        return null;
      });
  }

  function handleSubmit(form) {
    return function (event) {
      event.preventDefault();

      var apiBase = (form.getAttribute("data-api-base") || "").replace(/\/$/, "");
      var projectKey = form.getAttribute("data-project-key");

      if (!apiBase || !projectKey) {
        setMessage(form, "This form is misconfigured (missing data-api-base or data-project-key).", true);
        return;
      }

      var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      setMessage(form, "Sending…", false);

      var payload = collectFields(form);

      fetch(apiBase + "/api/v1/public/projects/" + encodeURIComponent(projectKey) + "/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, status: response.status, body: body };
          });
        })
        .then(function (result) {
          if (submitButton) submitButton.disabled = false;
          if (result.ok) {
            showThankYou(form, form.__devlaunchConfig);
            form.reset();
          } else {
            var message =
              (result.body && result.body.error && result.body.error.message) ||
              "Something went wrong. Please try again.";
            setMessage(form, message, true);
          }
        })
        .catch(function () {
          if (submitButton) submitButton.disabled = false;
          setMessage(form, "Network error. Please try again.", true);
        });
    };
  }

  function setupForm(form) {
    form.addEventListener("submit", handleSubmit(form));

    var apiBase = (form.getAttribute("data-api-base") || "").replace(/\/$/, "");
    var projectKey = form.getAttribute("data-project-key");
    if (!apiBase || !projectKey) return;

    fetchConfig(apiBase, projectKey).then(function (config) {
      form.__devlaunchConfig = config;
      if (config && config.widgetQualifyingQuestion) {
        renderQualifyingQuestion(form, config.widgetQualifyingQuestion);
      }
    });
  }

  function init() {
    qsa("form[data-devlaunch-lead-form]").forEach(setupForm);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
