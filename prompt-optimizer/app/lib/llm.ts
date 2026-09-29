import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";

// Claude Sonnet 4 ("claude-sonnet-4-20250514") is deprecated and past its
// announced retirement date, so requests against it fail. Sonnet 5 is the
// drop-in replacement for the same tier.
export const CLAUDE_MODEL = "claude-sonnet-5";

// Sonnet 5 runs adaptive thinking when "thinking" is omitted, and max_tokens
// caps thinking and response text together. Every call here wants a short,
// plain answer out of a small budget, so thinking stays off.
export const NO_THINKING = { type: "disabled" } as const;

let anthropic: Anthropic | null = null;
let groq: Groq | null = null;

export function getAnthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// The Groq constructor throws when GROQ_API_KEY is unset, so the client can
// only be built on demand: Groq is a fallback, and the routes that use it must
// still run when only Gemini is configured.
export function getGroq(): Groq {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured");
  }
  groq ??= new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
}

// Substitutes {{input}} without letting "$&", "$'" and friends inside the
// input act as replacement patterns.
export function fillPrompt(template: string, input: string): string {
  return template.replace(/\{\{input\}\}/g, () => input);
}

// Returns the first JSON object or array in a model response, or null when the
// response is missing or malformed.
export function parseJsonBlock<T>(
  text: string,
  shape: "object" | "array"
): T | null {
  const match =
    shape === "object" ? text.match(/\{[\s\S]*\}/) : text.match(/\[[\s\S]*\]/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

// Concatenates every text block, rather than only the first one.
export function messageText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
