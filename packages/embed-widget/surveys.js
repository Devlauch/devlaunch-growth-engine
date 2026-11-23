/*!
 * DevLaunch Growth Engine - embeddable multi-step form / survey widget
 * (NPS, CSAT, post-demo feedback, qualification forms).
 *
 * A SEPARATE file from embed.js (the lead-capture <form> widget),
 * chatbot.js (the AI chat bubble) and analytics.js (pageview/event
 * tracking) -- same conventions as all three: vanilla JS, no build step,
 * no framework, no dependencies, fails silently if misconfigured.
 *
 * Usage: paste a container plus a script tag on any page:
 *   <div data-devlaunch-survey
 *        data-api-base="https://api.yoursite.example"
 *        data-survey-id="..."></div>
 *   <script src=".../surveys.js" defer></script>
 *
 * What it does:
 *   - Fetches the survey's question schema: GET {api-base}/api/v1/public/surveys/{id}
 *   - Renders ONE step at a time (every question currently visible-and-
 *     unanswered, mirroring apps/api/src/lib/surveyEngine.ts's
 *     evaluateConditionalQuestions() -- the same small conditionalOn rule
 *     shape, reimplemented here in plain JS since this file can't import a
 *     TS module).
 *   - POSTs each step's answers to
 *     {api-base}/api/v1/public/surveys/{id}/responses, carrying forward the
 *     `responseId` the FIRST call returns so every later step (and the
 *     final submit) merges into the SAME response row instead of creating
 *     new ones -- this is what makes form-abandonment measurable
 *     server-side (lib/formAbandonmentTracking.ts).
 *   - Persists that in-progress responseId in sessionStorage (scoped to
 *     this survey id) so a reload mid-form resumes instead of restarting.
 *   - On the last visible question, submits with markComplete=true.
 *
 * CONSENT: same convention as analytics.js, read before relying on it for
 * compliance (this is a real technical control, not legal advice) -- when
 * the browser sends navigator.doNotTrack === "1" (or the legacy
 * window.doNotTrack / navigator.msDoNotTrack equivalents), OR the visitor
 * has opted out via window.devlaunchAnalytics.optOut() / this script's own
 * optOut() (same shared localStorage flag), the widget renders NOTHING and
 * never calls the API -- not even the initial schema fetch. This is
 * stricter than analytics.js (which still sends beacons unless opted out)
 * because a survey asks the visitor to actively submit personal responses,
 * not just passive pageview telemetry.
 */
(function () {
  "use strict";

  var OPT_OUT_KEY = "devlaunch_analytics_opt_out"; // shared with analytics.js on purpose: one consent decision.
  var RESPONSE_ID_KEY_PREFIX = "devlaunch_survey_response_";

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
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
      // ignore
    }
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

  function canRender() {
    return !hasDoNotTrack() && !hasOptedOut();
  }

  function randomVisitorId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID().replace(/-/g, "");
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }

  function getVisitorId() {
    // Reuses analytics.js's own visitor id when that script is present on
    // the same page (so a survey response correlates with the visitor's
    // analytics trail); otherwise mints a throwaway one for this session.
    if (window.devlaunchAnalytics && typeof window.devlaunchAnalytics.getVisitorId === "function") {
      try {
        return window.devlaunchAnalytics.getVisitorId();
      } catch (e) {
        // fall through
      }
    }
    return randomVisitorId();
  }

  // Mirrors apps/api/src/lib/surveyEngine.ts's evaluateConditionalQuestions()
  // exactly -- real branching logic, not a visual stub -- but in plain JS
  // since this file ships unbundled to arbitrary third-party pages.
  function conditionSatisfied(rule, answersSoFar) {
    if (!(rule.questionKey in answersSoFar)) return false;
    var actual = answersSoFar[rule.questionKey];
    if (rule.equals !== undefined) return actual === rule.equals;
    if (rule.notEquals !== undefined) return actual !== rule.notEquals;
    if (rule.in !== undefined) return rule.in.indexOf(actual) !== -1;
    return true;
  }

  function isQuestionVisible(question, answersSoFar) {
    if (!question.conditionalOn) return true;
    return conditionSatisfied(question.conditionalOn, answersSoFar);
  }

  function nextQuestions(allQuestions, answersSoFar) {
    return allQuestions.filter(function (q) {
      return isQuestionVisible(q, answersSoFar) && !(q.key in answersSoFar);
    });
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderQuestionInput(question, onAnswer) {
    var wrapper = document.createElement("div");
    wrapper.setAttribute("data-devlaunch-survey-question", question.key);
    wrapper.style.marginBottom = "12px";

    var label = document.createElement("label");
    label.textContent = question.label;
    label.style.display = "block";
    label.style.marginBottom = "6px";
    label.style.fontFamily = "sans-serif";
    label.style.fontSize = "14px";
    wrapper.appendChild(label);

    if (question.type === "nps" || question.type === "csat") {
      var max = question.type === "nps" ? 10 : 5;
      var scale = document.createElement("div");
      for (var i = question.type === "nps" ? 0 : 1; i <= max; i += 1) {
        (function (value) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = String(value);
          btn.style.marginRight = "4px";
          btn.addEventListener("click", function () {
            onAnswer(value);
          });
          scale.appendChild(btn);
        })(i);
      }
      wrapper.appendChild(scale);
    } else if (question.type === "single_choice" && question.options) {
      question.options.forEach(function (option) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = option;
        btn.style.display = "block";
        btn.style.marginBottom = "4px";
        btn.addEventListener("click", function () {
          onAnswer(option);
        });
        wrapper.appendChild(btn);
      });
    } else if (question.type === "multi_choice" && question.options) {
      var selected = [];
      var confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.textContent = "Continue";
      question.options.forEach(function (option) {
        var checkboxLabel = document.createElement("label");
        checkboxLabel.style.display = "block";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = option;
        checkbox.addEventListener("change", function () {
          var idx = selected.indexOf(option);
          if (checkbox.checked && idx === -1) selected.push(option);
          if (!checkbox.checked && idx !== -1) selected.splice(idx, 1);
        });
        checkboxLabel.appendChild(checkbox);
        checkboxLabel.appendChild(document.createTextNode(" " + option));
        wrapper.appendChild(checkboxLabel);
      });
      confirmBtn.addEventListener("click", function () {
        onAnswer(selected);
      });
      wrapper.appendChild(confirmBtn);
    } else if (question.type === "rating") {
      var ratingScale = document.createElement("div");
      for (var r = 1; r <= 5; r += 1) {
        (function (value) {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "★".repeat(value);
          btn.addEventListener("click", function () {
            onAnswer(value);
          });
          ratingScale.appendChild(btn);
        })(r);
      }
      wrapper.appendChild(ratingScale);
    } else {
      // text (default)
      var input = document.createElement("input");
      input.type = "text";
      input.style.width = "100%";
      var submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.textContent = "Continue";
      submitBtn.addEventListener("click", function () {
        onAnswer(input.value);
      });
      wrapper.appendChild(input);
      wrapper.appendChild(submitBtn);
    }

    return wrapper;
  }

  function buildWidget(container) {
    var apiBase = (container.getAttribute("data-api-base") || "").replace(/\/$/, "");
    var surveyId = container.getAttribute("data-survey-id");
    if (!apiBase || !surveyId || !canRender()) return;

    var responseIdKey = RESPONSE_ID_KEY_PREFIX + surveyId;
    var responseId = safeSessionStorageGet(responseIdKey) || undefined;
    var answers = {};
    var survey = null;

    function submitStep(stepAnswers, markComplete) {
      var body = {
        answers: stepAnswers,
        markComplete: Boolean(markComplete),
        visitorId: getVisitorId(),
      };
      if (responseId) body.responseId = responseId;

      return fetch(apiBase + "/api/v1/public/surveys/" + encodeURIComponent(surveyId) + "/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("submit failed");
          return res.json();
        })
        .then(function (data) {
          if (data && data.responseId) {
            responseId = data.responseId;
            safeSessionStorageSet(responseIdKey, responseId);
          }
          return data;
        });
    }

    function renderStep() {
      clearNode(container);
      var toShow = nextQuestions(survey.questions, answers);

      if (toShow.length === 0) {
        var thankYou = document.createElement("div");
        thankYou.setAttribute("role", "status");
        thankYou.textContent = "Thanks for your feedback!";
        container.appendChild(thankYou);
        return;
      }

      toShow.forEach(function (question) {
        var questionEl = renderQuestionInput(question, function (value) {
          answers[question.key] = value;
          var remainingAfterThis = nextQuestions(survey.questions, answers);
          var isLastStep = remainingAfterThis.length === 0;
          var stepAnswers = {};
          stepAnswers[question.key] = value;
          submitStep(stepAnswers, isLastStep)
            .catch(function () {
              // A dropped network call must never trap the visitor on a
              // dead step -- still advance the UI; the next step's submit
              // (or a future retry) can catch up server-side.
            })
            .then(function () {
              renderStep();
            });
        });
        container.appendChild(questionEl);
      });
    }

    fetch(apiBase + "/api/v1/public/surveys/" + encodeURIComponent(surveyId))
      .then(function (res) {
        if (!res.ok) throw new Error("survey fetch failed");
        return res.json();
      })
      .then(function (data) {
        survey = data.survey;
        renderStep();
      })
      .catch(function () {
        // Misconfigured/unknown survey id, or network error: render nothing
        // rather than a broken partial widget.
      });
  }

  function init() {
    qsa("[data-devlaunch-survey]").forEach(buildWidget);
  }

  window.devlaunchSurveys = { optOut: optOut, optIn: optIn, hasOptedOut: hasOptedOut };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
