/*!
 * DevLaunch Growth Engine - embeddable AI lead-capture chatbot widget.
 *
 * A SEPARATE file from embed.js (the lead-capture <form> widget) -- this one
 * renders its own floating chat bubble + panel, entirely client-side,
 * vanilla JS, no build step, no framework, no dependencies.
 *
 * Usage: paste
 *   <script src=".../chatbot.js" defer
 *           data-api-base="https://api.yoursite.example"
 *           data-project-key="pk_..."></script>
 * on any page of an external website (same per-project PUBLIC key + Origin
 * allowlist model as embed.js -- see that file's doc comment, and
 * apps/api/src/routes/publicChatbot.ts).
 *
 * What it does:
 *   - Renders a small floating "Chat with us" bubble in the bottom-right
 *     corner. Clicking it opens a chat panel.
 *   - On first open, calls POST {api-base}/api/v1/public/projects/{key}/chatbot/sessions
 *     to start a conversation and shows the bot's configured welcome message.
 *   - Every visitor message is POSTed to
 *     {api-base}/api/v1/public/projects/{key}/chatbot/sessions/{id}/messages
 *     and the bot's real reply (an approved knowledge-base answer, an honest
 *     "I don't know" fallback, a consent question, a qualifying question, or
 *     a contact-capture prompt -- apps/api decides, never this script) is
 *     appended to the panel.
 *   - All DOM content is set via textContent, never innerHTML, so nothing
 *     the bot or a visitor ever types can be interpreted as markup.
 *
 * What it deliberately does NOT do: it never decides what the bot says, it
 * never stores/sends anything beyond what the visitor types, and it never
 * talks to any third-party service. All matching, consent-gating, and lead
 * capture logic lives server-side (apps/api/src/lib/chatbotEngine.ts +
 * apps/api/src/routes/publicChatbot.ts).
 */
(function () {
  "use strict";

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === "style") {
          Object.assign(node.style, props.style);
        } else {
          node[key] = props[key];
        }
      });
    }
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function buildWidget(scriptEl) {
    var apiBase = (scriptEl.getAttribute("data-api-base") || "").replace(/\/$/, "");
    var projectKey = scriptEl.getAttribute("data-project-key");
    if (!apiBase || !projectKey) {
      return; // misconfigured -- fail silently, same convention as embed.js's config fetch
    }

    var conversationId = null;
    var sending = false;

    var bubble = el(
      "button",
      {
        type: "button",
        style: {
          position: "fixed",
          right: "20px",
          bottom: "20px",
          zIndex: "2147483000",
          borderRadius: "999px",
          padding: "12px 18px",
          border: "none",
          background: "#1a56db",
          color: "#fff",
          fontFamily: "sans-serif",
          fontSize: "14px",
          cursor: "pointer",
          boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
        },
      },
      ["Chat with us"],
    );

    var panel = el("div", {
      style: {
        position: "fixed",
        right: "20px",
        bottom: "70px",
        zIndex: "2147483000",
        width: "320px",
        maxWidth: "90vw",
        height: "420px",
        maxHeight: "70vh",
        display: "none",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: "10px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.2)",
        fontFamily: "sans-serif",
        overflow: "hidden",
      },
    });

    var header = el(
      "div",
      {
        style: {
          padding: "10px 12px",
          background: "#1a56db",
          color: "#fff",
          fontSize: "14px",
          fontWeight: "600",
        },
      },
      ["Chat with us"],
    );

    var messagesEl = el("div", {
      style: {
        flex: "1",
        overflowY: "auto",
        padding: "10px",
        fontSize: "13px",
        color: "#1a202c",
      },
    });

    var statusEl = el("div", {
      style: { padding: "0 10px", fontSize: "12px", color: "#b00020", minHeight: "0" },
    });

    var inputRow = el("div", {
      style: { display: "flex", borderTop: "1px solid #e2e8f0" },
    });
    var input = el("input", {
      type: "text",
      placeholder: "Type a message...",
      style: {
        flex: "1",
        border: "none",
        padding: "10px",
        fontSize: "13px",
        outline: "none",
      },
    });
    var sendButton = el(
      "button",
      {
        type: "button",
        style: {
          border: "none",
          background: "#1a56db",
          color: "#fff",
          padding: "0 16px",
          cursor: "pointer",
          fontSize: "13px",
        },
      },
      ["Send"],
    );

    inputRow.appendChild(input);
    inputRow.appendChild(sendButton);
    panel.appendChild(header);
    panel.appendChild(messagesEl);
    panel.appendChild(statusEl);
    panel.appendChild(inputRow);

    function appendMessage(role, content) {
      var row = el("div", {
        style: {
          margin: "6px 0",
          textAlign: role === "visitor" ? "right" : "left",
        },
      });
      var bubbleEl = el(
        "span",
        {
          style: {
            display: "inline-block",
            padding: "6px 10px",
            borderRadius: "10px",
            background: role === "visitor" ? "#1a56db" : "#edf2f7",
            color: role === "visitor" ? "#fff" : "#1a202c",
            maxWidth: "85%",
          },
        },
        [content],
      );
      row.appendChild(bubbleEl);
      messagesEl.appendChild(row);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function setStatus(message) {
      statusEl.textContent = message || "";
    }

    function startSession() {
      setStatus("Connecting...");
      return fetch(apiBase + "/api/v1/public/projects/" + encodeURIComponent(projectKey) + "/chatbot/sessions", {
        method: "POST",
      })
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
        .then(function (result) {
          setStatus("");
          if (!result.ok) {
            setStatus("This chat isn't available right now.");
            return;
          }
          conversationId = result.body.conversationId;
          appendMessage("bot", result.body.message);
        })
        .catch(function () {
          setStatus("Network error -- please try again.");
        });
    }

    function sendMessage(text) {
      if (!conversationId || sending) return;
      sending = true;
      sendButton.disabled = true;
      appendMessage("visitor", text);
      setStatus("");

      fetch(
        apiBase +
          "/api/v1/public/projects/" +
          encodeURIComponent(projectKey) +
          "/chatbot/sessions/" +
          encodeURIComponent(conversationId) +
          "/messages",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        },
      )
        .then(function (response) {
          return response.json().then(function (body) {
            return { ok: response.ok, body: body };
          });
        })
        .then(function (result) {
          sending = false;
          sendButton.disabled = false;
          if (!result.ok) {
            setStatus((result.body && result.body.error && result.body.error.message) || "Something went wrong.");
            return;
          }
          appendMessage("bot", result.body.message);
        })
        .catch(function () {
          sending = false;
          sendButton.disabled = false;
          setStatus("Network error -- please try again.");
        });
    }

    function handleSend() {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendMessage(text);
    }

    sendButton.addEventListener("click", handleSend);
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") handleSend();
    });

    var opened = false;
    bubble.addEventListener("click", function () {
      opened = !opened;
      panel.style.display = opened ? "flex" : "none";
      if (opened && !conversationId) {
        startSession();
      }
    });

    document.body.appendChild(bubble);
    document.body.appendChild(panel);
  }

  function init() {
    // Supports multiple chatbot script tags on one page (e.g. a staging
    // vs. production key) -- same convention as embed.js's qsa-based init,
    // though realistically only one is expected.
    var scripts = qsa("script[data-project-key][src*='chatbot.js']");
    if (scripts.length === 0) {
      // Fallback: document.currentScript covers the common single-tag case
      // even if the src match above misses (e.g. a renamed/bundled file).
      if (document.currentScript && document.currentScript.getAttribute("data-project-key")) {
        scripts = [document.currentScript];
      }
    }
    scripts.forEach(buildWidget);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
