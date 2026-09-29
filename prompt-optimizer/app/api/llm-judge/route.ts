import { NextRequest, NextResponse } from "next/server";
import {
  CLAUDE_MODEL,
  NO_THINKING,
  getAnthropic,
  messageText,
  parseJsonBlock,
} from "../../lib/llm";

const JUDGE_PROMPT = `You are an objective AI evaluator. Your task is to assess the quality of an AI assistant's response based strictly on the provided criteria.

EVALUATION CRITERIA:
1. Clarity (1-5): Is the response easy to understand? Is the language clear and well-structured?
2. Accuracy (1-5): Is the information factually correct and reliable?
3. Helpfulness (1-5): Does the response effectively address what was asked?
4. Completeness (1-5): Does the response cover all relevant aspects of the question?

RESPONSE TO EVALUATE:
"""
{output_text}
"""

INSTRUCTIONS:
- Rate each criterion on a scale of 1-5 (1=poor, 5=excellent)
- Be objective and consistent in your scoring
- Provide brief reasoning for each score
- Do not be influenced by response length alone
- Focus on quality, not style preferences

Respond ONLY with valid JSON in this exact format:
{
  "clarity": <number 1-5>,
  "accuracy": <number 1-5>,
  "helpfulness": <number 1-5>,
  "completeness": <number 1-5>,
  "reasoning": {
    "clarity": "<one sentence explanation>",
    "accuracy": "<one sentence explanation>",
    "helpfulness": "<one sentence explanation>",
    "completeness": "<one sentence explanation>"
  },
  "overall_score": <average of all scores>
}`;

const CRITERIA = ["clarity", "accuracy", "helpfulness", "completeness"] as const;

type Criterion = (typeof CRITERIA)[number];

interface Evaluation {
  clarity: number;
  accuracy: number;
  helpfulness: number;
  completeness: number;
  reasoning: Record<Criterion, string>;
  overall_score: number;
}

function toScore(value: unknown): number {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.min(5, Math.max(0, score));
}

// The judge is asked for an exact shape but is not guaranteed to return it, and
// the UI reads every field unconditionally.
function normalizeEvaluation(raw: Record<string, unknown>): Evaluation {
  const scores = {} as Record<Criterion, number>;
  const reasoning = {} as Record<Criterion, string>;
  const rawReasoning = (raw.reasoning ?? {}) as Record<string, unknown>;

  for (const criterion of CRITERIA) {
    scores[criterion] = toScore(raw[criterion]);
    reasoning[criterion] =
      typeof rawReasoning[criterion] === "string"
        ? (rawReasoning[criterion] as string)
        : "No reasoning provided";
  }

  const reported = Number(raw.overall_score);
  const overall = Number.isFinite(reported)
    ? Math.min(5, Math.max(0, reported))
    : CRITERIA.reduce((sum, criterion) => sum + scores[criterion], 0) /
      CRITERIA.length;

  return { ...scores, reasoning, overall_score: overall };
}

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt string is required" },
        { status: 400 }
      );
    }

    const anthropic = getAnthropic();

    // Step 1: Get the initial AI response
    const initialMessage = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: prompt }],
    });

    const aiOutput = messageText(initialMessage);
    if (!aiOutput) {
      throw new Error("No text content in initial response");
    }

    // Step 2: Send the output to a judge AI (without the original prompt).
    // The replacement runs through a function so "$&" and similar sequences in
    // the output are inserted literally instead of being expanded.
    const judgePrompt = JUDGE_PROMPT.replace("{output_text}", () => aiOutput);

    const judgeMessage = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: judgePrompt }],
    });

    const judgeText = messageText(judgeMessage);
    if (!judgeText) {
      throw new Error("No text content in judge response");
    }

    const parsed = parseJsonBlock<Record<string, unknown>>(judgeText, "object");
    if (!parsed) {
      throw new Error("Could not parse judge evaluation");
    }

    return NextResponse.json({
      success: true,
      prompt: prompt,
      ai_response: aiOutput,
      evaluation: normalizeEvaluation(parsed),
    });
  } catch (error) {
    console.error("Error in LLM judge API:", error);
    return NextResponse.json(
      {
        error: "Failed to evaluate with LLM judge",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
