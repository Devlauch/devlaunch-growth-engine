import { describe, it, expect } from "vitest";
import {
  matchKnowledge,
  detectsEnquiryIntent,
  parseYesNo,
  extractContact,
  extractFaqSnippets,
  DEFAULT_CONFIDENCE_THRESHOLD,
  type KnowledgeSourceCandidate,
} from "../src/lib/chatbotEngine.js";

const KNOWLEDGE_BASE: KnowledgeSourceCandidate[] = [
  {
    id: "kb-pricing",
    question: "How much does your product cost?",
    answer: "Our pricing starts at $99/month for the starter plan, billed monthly.",
    tags: ["pricing", "cost", "plans"],
  },
  {
    id: "kb-hours",
    question: "What are your support hours?",
    answer: "Our support team is available Monday to Friday, 9am to 6pm.",
    tags: ["support", "hours"],
  },
  {
    id: "kb-integrations",
    question: "Does this integrate with Salesforce?",
    answer: "Yes, we have a native Salesforce integration available on all paid plans.",
    tags: ["integrations", "salesforce", "crm"],
  },
];

describe("chatbotEngine.matchKnowledge", () => {
  it("picks the knowledge entry whose question/tags best overlap the visitor's message", () => {
    const result = matchKnowledge("What's the cost of your pricing plans?", KNOWLEDGE_BASE);
    expect(result).not.toBeNull();
    expect(result!.sourceId).toBe("kb-pricing");
    expect(result!.answer).toContain("$99/month");
  });

  it("picks a different entry correctly when the message is about something else", () => {
    const result = matchKnowledge("Do you integrate with Salesforce CRM?", KNOWLEDGE_BASE);
    expect(result).not.toBeNull();
    expect(result!.sourceId).toBe("kb-integrations");
  });

  it("picks support-hours entry for a question about availability", () => {
    const result = matchKnowledge("What are your support hours on Friday?", KNOWLEDGE_BASE);
    expect(result).not.toBeNull();
    expect(result!.sourceId).toBe("kb-hours");
  });

  it("returns a confidence score between 0 and 1", () => {
    const result = matchKnowledge("How much does your product cost?", KNOWLEDGE_BASE);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBeGreaterThan(0);
    expect(result!.confidence).toBeLessThanOrEqual(1);
  });

  it("honestly falls back to null when nothing scores above the confidence threshold", () => {
    const result = matchKnowledge("What's the weather like in Antarctica today?", KNOWLEDGE_BASE);
    expect(result).toBeNull();
  });

  it("returns null for an empty message", () => {
    expect(matchKnowledge("", KNOWLEDGE_BASE)).toBeNull();
  });

  it("returns null when there are no knowledge entries at all", () => {
    expect(matchKnowledge("anything at all", [])).toBeNull();
  });

  it("respects a stricter custom confidence threshold", () => {
    // "monthly" only overlaps the ANSWER body of kb-pricing (weight 1 of a
    // possible 3), a weak ~0.33 score -- clears a lenient threshold but not
    // a much stricter one.
    const weakMessage = "monthly";
    const lenient = matchKnowledge(weakMessage, KNOWLEDGE_BASE, 0.01);
    const strict = matchKnowledge(weakMessage, KNOWLEDGE_BASE, 0.5);
    expect(lenient).not.toBeNull();
    expect(strict).toBeNull();
  });

  it("DEFAULT_CONFIDENCE_THRESHOLD is a sane real number between 0 and 1", () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});

describe("chatbotEngine.detectsEnquiryIntent", () => {
  it("detects an explicit request to talk to someone", () => {
    expect(detectsEnquiryIntent("I'd like to talk to someone about this")).toBe(true);
  });

  it("detects pricing/quote intent", () => {
    expect(detectsEnquiryIntent("Can you give me a quote? I want to get a quote")).toBe(true);
    expect(detectsEnquiryIntent("what's your pricing")).toBe(true);
  });

  it("does not flag an ordinary FAQ-style question", () => {
    expect(detectsEnquiryIntent("What are your support hours?")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(detectsEnquiryIntent("")).toBe(false);
  });
});

describe("chatbotEngine.parseYesNo", () => {
  it("parses a clear yes", () => {
    expect(parseYesNo("Yes")).toBe(true);
    expect(parseYesNo("sure, go ahead")).toBe(true);
  });

  it("parses a clear no", () => {
    expect(parseYesNo("no thanks")).toBe(false);
    expect(parseYesNo("Nope")).toBe(false);
  });

  it("honestly returns null for an ambiguous reply rather than guessing", () => {
    expect(parseYesNo("maybe later")).toBeNull();
    expect(parseYesNo("what do you mean?")).toBeNull();
  });
});

describe("chatbotEngine.extractContact", () => {
  it("extracts both a name and an email", () => {
    const result = extractContact("I'm Jane Doe, jane.doe@example.com");
    expect(result.email).toBe("jane.doe@example.com");
    expect(result.name).toBe("Jane Doe");
  });

  it("extracts only an email when no name text precedes it", () => {
    const result = extractContact("jane.doe@example.com");
    expect(result.email).toBe("jane.doe@example.com");
  });

  it("extracts only a name when no email is present", () => {
    const result = extractContact("Jane Doe");
    expect(result.name).toBe("Jane Doe");
    expect(result.email).toBeNull();
  });
});

describe("chatbotEngine.extractFaqSnippets", () => {
  it("pairs a question sentence with the following sentence as the answer", () => {
    const text = "What is your refund policy? We offer a 30 day money back guarantee. Thanks for visiting.";
    const snippets = extractFaqSnippets(text);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].question).toBe("What is your refund policy?");
    expect(snippets[0].answer).toContain("30 day money back guarantee");
  });

  it("never fabricates text -- every snippet is verbatim from the input", () => {
    const text = "Do you offer onboarding support? Yes, every plan includes free onboarding support.";
    const snippets = extractFaqSnippets(text);
    for (const snippet of snippets) {
      expect(text).toContain(snippet.question);
      expect(text).toContain(snippet.answer);
    }
  });

  it("returns an empty array when there are no question sentences", () => {
    expect(extractFaqSnippets("This is just plain text. Nothing here is a question.")).toEqual([]);
  });
});
