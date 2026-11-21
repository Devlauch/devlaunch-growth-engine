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
 *   - On submit, collects fields named name/email/company/message, plus
 *     any other named field as a "custom field".
 *   - POSTs them as JSON to
 *     {data-api-base}/api/v1/public/projects/{data-project-key}/leads
 *   - Shows a success/error message in an element the form already has
 *     (or one this script creates) — never navigates away or reloads.
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

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function setStatus(form, message, isError) {
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

  function collectFields(form) {
    var known = ["name", "email", "company", "message"];
    var payload = { customFields: {} };
    var formData = new FormData(form);

    formData.forEach(function (value, key) {
      if (typeof value !== "string") return; // skip File inputs
      if (known.indexOf(key) !== -1) {
        payload[key] = value;
      } else {
        payload.customFields[key] = value;
      }
    });

    return payload;
  }

  function handleSubmit(form) {
    return function (event) {
      event.preventDefault();

      var apiBase = (form.getAttribute("data-api-base") || "").replace(/\/$/, "");
      var projectKey = form.getAttribute("data-project-key");

      if (!apiBase || !projectKey) {
        setStatus(form, "This form is misconfigured (missing data-api-base or data-project-key).", true);
        return;
      }

      var submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitButton) submitButton.disabled = true;
      setStatus(form, "Sending…", false);

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
            setStatus(form, form.getAttribute("data-success-message") || "Thanks! We'll be in touch.", false);
            form.reset();
          } else {
            var message =
              (result.body && result.body.error && result.body.error.message) ||
              "Something went wrong. Please try again.";
            setStatus(form, message, true);
          }
        })
        .catch(function () {
          if (submitButton) submitButton.disabled = false;
          setStatus(form, "Network error. Please try again.", true);
        });
    };
  }

  function init() {
    qsa("form[data-devlaunch-lead-form]").forEach(function (form) {
      form.addEventListener("submit", handleSubmit(form));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
