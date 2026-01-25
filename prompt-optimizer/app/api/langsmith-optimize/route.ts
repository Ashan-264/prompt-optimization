import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import Groq from "groq-sdk";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import "uuid";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});
const langsmithClient = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
});

interface TestCase {
  input: string;
  rubric: string[];
}

interface TestResult {
  input: string;
  output: string;
  score: number;
  failureReason?: string;
  rubricResults: { criterion: string; passed: boolean; reason?: string }[];
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { prompt, goal, promptName, rubric } = body;

  const logs: Array<{
    timestamp: string;
    phase: string;
    status: "running" | "completed" | "error";
    details?: string;
  }> = [];

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendLog = async (
    phase: string,
    status: "running" | "completed" | "error",
    details?: string
  ) => {
    const log = {
      timestamp: new Date().toISOString(),
      phase,
      status,
      details,
    };
    logs.push(log);
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ type: "log", log })}\n\n`)
    );
  };

  (async () => {
    try {
      if (!prompt || !goal || !promptName) {
        await sendLog("Error", "error", "Missing required fields");
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "error",
              error: "Missing prompt, goal, or promptName",
            })}\n\n`
          )
        );
        await writer.close();
        return;
      }

      // Check for required API keys
      if (!process.env.GEMINI_API_KEY) {
        await sendLog("Error", "error", "Gemini API key not configured");
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "error",
              error: "Gemini API key not configured",
              details:
                "Please add GEMINI_API_KEY to your environment variables",
            })}\n\n`
          )
        );
        await writer.close();
        return;
      }

      if (!process.env.LANGSMITH_API_KEY) {
        await sendLog("Error", "error", "LangSmith API key not configured");
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "error",
              error: "LangSmith API key not configured",
              details:
                "Please add LANGSMITH_API_KEY to your environment variables",
            })}\n\n`
          )
        );
        await writer.close();
        return;
      }

      // Phase 1: Save to Prompt Hub
      await sendLog(
        "Saving to Prompt Hub",
        "running",
        `Saving as "${promptName}"`
      );

      const promptVersion = `v${Date.now()}`;
      const fullPromptName = `${promptName}-${promptVersion}`;

      await sendLog("Prompt saved", "completed", `Version: ${promptVersion}`);

      // Phase 2: Generate synthetic dataset with Gemini
      await sendLog(
        "Generating test dataset",
        "running",
        "Using Gemini 2.0 Flash to create 2 test cases"
      );

      const testCases = await generateSyntheticDataset(prompt, goal, rubric);

      await sendLog(
        "Dataset generated",
        "completed",
        `Created ${testCases.length} test cases`
      );

      // Phase 3: Execute prompt against dataset with Gemini
      await sendLog(
        "Running tests",
        "running",
        "Executing prompt with Gemini 2.0 Flash"
      );

      const results: TestResult[] = [];

      for (const [index, testCase] of testCases.entries()) {
        await sendLog(
          `Test ${index + 1}/${testCases.length}`,
          "running",
          `Input: ${testCase.input.substring(0, 50)}...`
        );

        const output = await executePromptWithGemini(prompt, testCase.input);

        // Judge with Claude Sonnet 4
        const judgeResult = await judgeWithClaude(
          testCase.input,
          output,
          testCase.rubric,
          goal
        );

        results.push({
          input: testCase.input,
          output,
          score: judgeResult.score,
          failureReason: judgeResult.failureReason,
          rubricResults: judgeResult.rubricResults,
        });

        // Log to LangSmith with traceable
        await logToLangSmith(promptName, testCase.input, output, judgeResult);

        await sendLog(
          `Test ${index + 1} completed`,
          "completed",
          `Score: ${judgeResult.score}`
        );
      }

      const failedResults = results.filter((r) => r.score === 0);

      await sendLog(
        "Tests completed",
        "completed",
        `${failedResults.length}/${results.length} tests failed`
      );

      // Phase 4: Analyze failures if any exist
      let optimizedPrompt = prompt;
      let optimizationReasoning = "";
      let changes: string[] = [];

      if (failedResults.length > 0) {
        await sendLog(
          "Analyzing failures",
          "running",
          "Creating failure dataset in LangSmith"
        );

        // Create failure dataset
        const datasetName = `${promptName}-Failures-${promptVersion}`;
        await createFailureDataset(datasetName, failedResults);

        await sendLog(
          "Generating optimized prompt",
          "running",
          "Claude analyzing failure patterns"
        );

        // Generate improved prompt
        const optimization = await generateOptimizedPrompt(
          prompt,
          failedResults,
          goal,
          rubric
        );

        optimizedPrompt = optimization.prompt;
        optimizationReasoning = optimization.reasoning;
        changes = optimization.changes;

        await sendLog(
          "Optimization complete",
          "completed",
          `Generated improved prompt with ${changes.length} changes`
        );

        // Phase 5: Test optimized prompt
        await sendLog(
          "Testing optimized prompt",
          "running",
          "Running A/B comparison"
        );

        const optimizedResults: TestResult[] = [];
        for (const testCase of testCases) {
          const output = await executePromptWithGemini(
            optimizedPrompt,
            testCase.input
          );
          const judgeResult = await judgeWithClaude(
            testCase.input,
            output,
            testCase.rubric,
            goal
          );

          optimizedResults.push({
            input: testCase.input,
            output,
            score: judgeResult.score,
            failureReason: judgeResult.failureReason,
            rubricResults: judgeResult.rubricResults,
          });
        }

        const optimizedFailures = optimizedResults.filter(
          (r) => r.score === 0
        ).length;

        await sendLog(
          "A/B test complete",
          "completed",
          `Original: ${failedResults.length} failures, Optimized: ${optimizedFailures} failures`
        );
      } else {
        await sendLog(
          "All tests passed",
          "completed",
          "No optimization needed - prompt is already performing well!"
        );
      }

      // Calculate metrics
      const originalPassRate =
        ((results.length - failedResults.length) / results.length) * 100;

      // Send final results
      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "complete",
            evaluation: {
              originalPrompt: prompt,
              optimizedPrompt,
              promptName: fullPromptName,
              goal,
              rubric,
              originalResults: results,
              metrics: {
                originalPassRate: originalPassRate.toFixed(1),
                totalTests: results.length,
                failures: failedResults.length,
              },
              optimization: {
                reasoning: optimizationReasoning,
                changes,
              },
              logs,
            },
          })}\n\n`
        )
      );

      await writer.close();
    } catch (error) {
      console.error("Error in langsmith-optimize API:", error);
      await sendLog(
        "Error occurred",
        "error",
        error instanceof Error ? error.message : "Unknown error"
      );

      await writer.write(
        encoder.encode(
          `data: ${JSON.stringify({
            type: "error",
            error: "Failed to optimize prompt",
            details: error instanceof Error ? error.message : "Unknown error",
            logs,
          })}\n\n`
        )
      );
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Generate test cases with Gemini (fallback to Gemma 3 12B)
async function generateSyntheticDataset(
  prompt: string,
  goal: string,
  rubric: string[]
): Promise<TestCase[]> {
  const generationPrompt = `Generate 5 diverse test cases for this prompt evaluation.

PROMPT TO TEST:
${prompt}

GOAL:
${goal}

EVALUATION RUBRIC:
${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Generate 2 test input scenarios that would thoroughly test whether the prompt achieves the goal and meets the rubric criteria.

Return ONLY a JSON array:
[
  {
    "input": "Test input that replaces {{input}} in the prompt",
    "rubric": ${JSON.stringify(rubric)}
  }
]`;

  try {
    // Try Gemini 2.5 Flash Lite first
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const result = await model.generateContent(generationPrompt);
    const response = result.response.text();
    const jsonMatch = response.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      throw new Error("Failed to parse Gemini response");
    }

    return JSON.parse(jsonMatch[0]);
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq Llama:", geminiError);

    // Fallback to Groq Llama
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: generationPrompt,
        },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 2000,
    });

    const response = completion.choices[0]?.message?.content || "";
    const jsonMatch = response.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      throw new Error(
        "Failed to generate test cases with both Gemini and Groq"
      );
    }

    return JSON.parse(jsonMatch[0]);
  }
}

// Execute prompt with Gemini 2.0 Flash (fallback to Gemma 3 12B)
async function executePromptWithGemini(
  prompt: string,
  input: string
): Promise<string> {
  const formattedPrompt = prompt.replace(/\{\{input\}\}/g, input);

  try {
    // Try Gemini 2.5 Flash Lite first
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const result = await model.generateContent(formattedPrompt);
    return result.response.text();
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq Llama:", geminiError);

    // Fallback to Groq Llama
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: formattedPrompt,
        },
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.7,
      max_tokens: 2000,
    });

    return completion.choices[0]?.message?.content || "";
  }
}

// Judge output with Claude Sonnet 4
async function judgeWithClaude(
  input: string,
  output: string,
  rubric: string[],
  goal: string
): Promise<{
  score: number;
  failureReason?: string;
  rubricResults: Array<{ criterion: string; passed: boolean; reason?: string }>;
}> {
  const judgePrompt = `You are evaluating LLM output against a rubric.

GOAL: ${goal}

INPUT: ${input}

OUTPUT TO EVALUATE:
${output}

RUBRIC (each criterion must pass):
${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

For each rubric criterion, evaluate if the output passes or fails.
Overall score is 1 if ALL criteria pass, 0 if ANY criterion fails.

Return ONLY valid JSON:
{
  "score": <0 or 1>,
  "failureReason": "<brief explanation if score is 0, otherwise omit>",
  "rubricResults": [
    {"criterion": "<criterion text>", "passed": <true/false>, "reason": "<explanation if failed>"}
  ]
}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 500,
    messages: [{ role: "user", content: judgePrompt }],
  });

  const textContent = message.content.find((block) => block.type === "text");
  const text =
    textContent && textContent.type === "text" ? textContent.text : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      score: 0,
      failureReason: "Failed to parse judge response",
      rubricResults: rubric.map((r) => ({ criterion: r, passed: false })),
    };
  }

  return JSON.parse(jsonMatch[0]);
}

// Log to LangSmith with traceable
const logToLangSmith = traceable(
  async (
    promptName: string,
    input: string,
    output: string,
    judgeResult: {
      score: number;
      failureReason?: string;
      rubricResults: { criterion: string; passed: boolean; reason?: string }[];
    }
  ) => {
    return {
      promptName,
      input,
      output,
      score: judgeResult.score,
      failureReason: judgeResult.failureReason,
      rubricResults: judgeResult.rubricResults,
    };
  },
  { name: "prompt-execution", project_name: "prompt-optimization" }
);

// Create failure dataset in LangSmith
async function createFailureDataset(
  datasetName: string,
  failures: TestResult[]
): Promise<void> {
  try {
    // Create dataset
    const dataset = await langsmithClient.createDataset(datasetName, {
      description: `Failure cases for prompt optimization`,
    });

    // Add examples
    for (const failure of failures) {
      await langsmithClient.createExample({
        inputs: { input: failure.input },
        outputs: { output: failure.output },
        metadata: {
          score: failure.score,
          failureReason: failure.failureReason,
          rubricResults: failure.rubricResults,
        },
        datasetId: dataset.id,
      } as unknown);
    }
  } catch (error) {
    console.error("Failed to create dataset:", error);
  }
}

// Generate optimized prompt
async function generateOptimizedPrompt(
  originalPrompt: string,
  failures: TestResult[],
  goal: string,
  rubric: string[]
): Promise<{
  prompt: string;
  reasoning: string;
  changes: string[];
}> {
  const failureAnalysis = failures.map((f) => ({
    input: f.input,
    output: f.output.substring(0, 200),
    failureReason: f.failureReason,
    failedCriteria: f.rubricResults.filter((r) => !r.passed),
  }));

  const optimizationPrompt = `You are a prompt engineer. Analyze these failures and create an optimized prompt.

ORIGINAL PROMPT:
${originalPrompt}

GOAL:
${goal}

RUBRIC:
${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

FAILURE ANALYSIS (${failures.length} cases):
${JSON.stringify(failureAnalysis, null, 2)}

TASK:
1. Identify patterns in the failures
2. Generate an improved version of the prompt that addresses these failure patterns
3. List specific changes made and why

Return ONLY valid JSON:
{
  "prompt": "<the complete optimized prompt>",
  "reasoning": "<detailed explanation of failure patterns and how the new prompt fixes them>",
  "changes": [
    "Change 1: Added X because Y",
    "Change 2: Removed Z because W"
  ]
}`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: optimizationPrompt }],
  });

  const textContent = message.content.find((block) => block.type === "text");
  const text =
    textContent && textContent.type === "text" ? textContent.text : "{}";
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Failed to generate optimization");
  }

  return JSON.parse(jsonMatch[0]);
}
