import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

export async function POST(request: NextRequest) {
  try {
    const { prompt } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt string is required" },
        { status: 400 }
      );
    }

    // Step 1: Get the initial AI response
    const initialMessage = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const initialTextContent = initialMessage.content.find(
      (block) => block.type === "text"
    );
    if (!initialTextContent || initialTextContent.type !== "text") {
      throw new Error("No text content in initial response");
    }

    const aiOutput = initialTextContent.text;

    // Step 2: Send the output to a judge AI (without the original prompt)
    const judgePrompt = JUDGE_PROMPT.replace("{output_text}", aiOutput);

    const judgeMessage = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: judgePrompt }],
    });

    const judgeTextContent = judgeMessage.content.find(
      (block) => block.type === "text"
    );
    if (!judgeTextContent || judgeTextContent.type !== "text") {
      throw new Error("No text content in judge response");
    }

    // Parse the judge's evaluation
    const jsonMatch = judgeTextContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse judge evaluation");
    }

    const evaluation = JSON.parse(jsonMatch[0]);

    return NextResponse.json({
      success: true,
      prompt: prompt,
      ai_response: aiOutput,
      evaluation: evaluation,
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
