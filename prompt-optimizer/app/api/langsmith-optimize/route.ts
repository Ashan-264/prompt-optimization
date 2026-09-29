import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Client } from "langsmith";
import { traceable } from "langsmith/traceable";
import {
  CLAUDE_MODEL,
  NO_THINKING,
  fillPrompt,
  getAnthropic,
  getGroq,
  messageText,
  parseJsonBlock,
} from "../../lib/llm";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const langsmithClient = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
});

const TEST_CASE_COUNT = 5;

interface TestCase {
  input: string;
  rubric: string[];
}

interface RubricResult {
  criterion: string;
  passed: boolean;
  reason?: string;
}

interface JudgeResult {
  score: number;
  failureReason?: string;
  rubricResults: RubricResult[];
}

interface TestResult {
  input: string;
  output: string;
  score: number;
  failureReason?: string;
  rubricResults: RubricResult[];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { prompt, goal, promptName } = body;
  const rubric = toStringArray(body.rubric);

  const logs: Array<{
    timestamp: string;
    phase: string;
    status: "running" | "completed" | "error";
    details?: string;
  }> = [];

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  // Once the browser disconnects, every write rejects. Without this guard the
  // failure inside the catch block became an unhandled rejection.
  let streamClosed = false;

  const send = async (payload: unknown) => {
    if (streamClosed) return;
    try {
      await writer.write(
        encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
      );
    } catch (error) {
      streamClosed = true;
      console.warn("SSE client disconnected:", error);
    }
  };

  const closeStream = async () => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      await writer.close();
    } catch {
      // Already closed or aborted by the client.
    }
  };

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
    await send({ type: "log", log });
  };

  const fail = async (error: string, details?: string) => {
    await sendLog("Error", "error", details ?? error);
    await send({ type: "error", error, details });
    await closeStream();
  };

  (async () => {
    try {
      if (!prompt || !goal || !promptName) {
        await fail("Missing prompt, goal, or promptName", "Missing required fields");
        return;
      }

      if (rubric.length === 0) {
        await fail(
          "At least one rubric criterion is required",
          "Rubric was empty or not a list of strings"
        );
        return;
      }

      // Check for required API keys
      if (!process.env.GEMINI_API_KEY) {
        await fail(
          "Gemini API key not configured",
          "Please add GEMINI_API_KEY to your environment variables"
        );
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        await fail(
          "Anthropic API key not configured",
          "Please add ANTHROPIC_API_KEY to your environment variables"
        );
        return;
      }

      if (!process.env.LANGSMITH_API_KEY) {
        await fail(
          "LangSmith API key not configured",
          "Please add LANGSMITH_API_KEY to your environment variables"
        );
        return;
      }

      // Phase 1: Version this run. Nothing is pushed to the LangSmith Prompt
      // Hub here - the failure dataset below is what lands in LangSmith.
      const promptVersion = `v${Date.now()}`;
      const fullPromptName = `${promptName}-${promptVersion}`;

      await sendLog(
        "Versioning prompt",
        "completed",
        `Tracking this run as "${fullPromptName}"`
      );

      // Phase 2: Generate synthetic dataset with Gemini
      await sendLog(
        "Generating test dataset",
        "running",
        `Using Gemini 2.5 Flash Lite to create ${TEST_CASE_COUNT} test cases`
      );

      const testCases = await generateSyntheticDataset(prompt, goal, rubric);

      if (testCases.length === 0) {
        await fail(
          "Failed to generate any usable test cases",
          "The dataset generator returned no test cases with a usable input"
        );
        return;
      }

      await sendLog(
        "Dataset generated",
        "completed",
        `Created ${testCases.length} test cases`
      );

      // Phase 3: Execute prompt against dataset with Gemini
      await sendLog(
        "Running tests",
        "running",
        "Executing prompt with Gemini 2.5 Flash Lite"
      );

      const results: TestResult[] = [];

      for (const [index, testCase] of testCases.entries()) {
        await sendLog(
          `Test ${index + 1}/${testCases.length}`,
          "running",
          `Input: ${testCase.input.substring(0, 50)}...`
        );

        const output = await executePromptWithGemini(prompt, testCase.input);

        // Judge with Claude
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
      const optimizedResults: TestResult[] = [];
      let optimizedFailures = 0;

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

        optimizedFailures = optimizedResults.filter((r) => r.score === 0).length;

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

      // Calculate metrics. Guarded: an empty result set would report NaN.
      const passRate = (failures: number, total: number) =>
        total > 0 ? ((total - failures) / total) * 100 : 0;

      const originalPassRate = passRate(failedResults.length, results.length);
      const hasOptimizedRun = optimizedResults.length > 0;

      // Send final results
      await send({
        type: "complete",
        evaluation: {
          originalPrompt: prompt,
          optimizedPrompt,
          promptName: fullPromptName,
          goal,
          rubric,
          originalResults: results,
          // The A/B run was previously computed and then discarded, so the UI
          // could never show what the optimized prompt actually scored.
          optimizedResults,
          metrics: {
            originalPassRate: originalPassRate.toFixed(1),
            optimizedPassRate: hasOptimizedRun
              ? passRate(optimizedFailures, optimizedResults.length).toFixed(1)
              : null,
            totalTests: results.length,
            failures: failedResults.length,
            optimizedFailures: hasOptimizedRun ? optimizedFailures : null,
          },
          optimization: {
            reasoning: optimizationReasoning,
            changes,
          },
          logs,
        },
      });

      await closeStream();
    } catch (error) {
      console.error("Error in langsmith-optimize API:", error);
      await sendLog(
        "Error occurred",
        "error",
        error instanceof Error ? error.message : "Unknown error"
      );

      await send({
        type: "error",
        error: "Failed to optimize prompt",
        details: error instanceof Error ? error.message : "Unknown error",
        logs,
      });
      await closeStream();
    }
  })().catch((error) => {
    // Last resort: never let the detached task reject unhandled.
    console.error("Unhandled langsmith-optimize stream error:", error);
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// The generator models are free-form, so entries without a usable input are
// dropped and a missing per-case rubric falls back to the run's rubric.
function normalizeTestCases(value: unknown, rubric: string[]): TestCase[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): TestCase[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.input !== "string" || !candidate.input.trim()) {
      return [];
    }

    const caseRubric = toStringArray(candidate.rubric);
    return [
      {
        input: candidate.input,
        rubric: caseRubric.length > 0 ? caseRubric : rubric,
      },
    ];
  });
}

// Generate test cases with Gemini (fallback to Groq Llama)
async function generateSyntheticDataset(
  prompt: string,
  goal: string,
  rubric: string[]
): Promise<TestCase[]> {
  const generationPrompt = `Generate ${TEST_CASE_COUNT} diverse test cases for this prompt evaluation.

PROMPT TO TEST:
${prompt}

GOAL:
${goal}

EVALUATION RUBRIC:
${rubric.map((r, i) => `${i + 1}. ${r}`).join("\n")}

Generate ${TEST_CASE_COUNT} test input scenarios that would thoroughly test whether the prompt achieves the goal and meets the rubric criteria.

Return ONLY a JSON array of ${TEST_CASE_COUNT} objects in this shape:
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
    const testCases = normalizeTestCases(
      parseJsonBlock<unknown>(result.response.text(), "array"),
      rubric
    );

    if (testCases.length === 0) {
      throw new Error("Failed to parse Gemini response");
    }

    return testCases;
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq Llama:", geminiError);

    if (!process.env.GROQ_API_KEY) {
      throw new Error(
        "Failed to generate test cases with Gemini, and GROQ_API_KEY is not configured for fallback"
      );
    }

    // Fallback to Groq Llama
    const completion = await getGroq().chat.completions.create({
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
    const testCases = normalizeTestCases(
      parseJsonBlock<unknown>(response, "array"),
      rubric
    );

    if (testCases.length === 0) {
      throw new Error(
        "Failed to generate test cases with both Gemini and Groq"
      );
    }

    return testCases;
  }
}

// Execute prompt with Gemini (fallback to Groq Llama)
async function executePromptWithGemini(
  prompt: string,
  input: string
): Promise<string> {
  const formattedPrompt = fillPrompt(prompt, input);

  try {
    // Try Gemini 2.5 Flash Lite first
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const result = await model.generateContent(formattedPrompt);
    return result.response.text();
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq Llama:", geminiError);

    if (!process.env.GROQ_API_KEY) {
      throw new Error(
        "Failed to execute prompt with Gemini, and GROQ_API_KEY is not configured for fallback"
      );
    }

    // Fallback to Groq Llama
    const completion = await getGroq().chat.completions.create({
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

// Judge output with Claude
async function judgeWithClaude(
  input: string,
  output: string,
  rubric: string[],
  goal: string
): Promise<JudgeResult> {
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

  const unscored = (failureReason: string): JudgeResult => ({
    score: 0,
    failureReason,
    rubricResults: rubric.map((r) => ({ criterion: r, passed: false })),
  });

  // Enough room for one entry per criterion; a truncated response would fail
  // to parse and silently score every test zero.
  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    thinking: NO_THINKING,
    messages: [{ role: "user", content: judgePrompt }],
  });

  const parsed = parseJsonBlock<Record<string, unknown>>(
    messageText(message),
    "object"
  );
  if (!parsed) {
    return unscored("Failed to parse judge response");
  }

  // rubricResults is read downstream by the optimizer, so it must be an array.
  const rubricResults = Array.isArray(parsed.rubricResults)
    ? parsed.rubricResults.flatMap((entry): RubricResult[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const candidate = entry as Record<string, unknown>;
        return [
          {
            criterion:
              typeof candidate.criterion === "string"
                ? candidate.criterion
                : "Unnamed criterion",
            passed: candidate.passed === true,
            reason:
              typeof candidate.reason === "string" ? candidate.reason : undefined,
          },
        ];
      })
    : [];

  return {
    score: Number(parsed.score) === 1 ? 1 : 0,
    failureReason:
      typeof parsed.failureReason === "string"
        ? parsed.failureReason
        : undefined,
    rubricResults:
      rubricResults.length > 0
        ? rubricResults
        : rubric.map((r) => ({ criterion: r, passed: Number(parsed.score) === 1 })),
  };
}

// Log to LangSmith with traceable
const logToLangSmith = traceable(
  async (
    promptName: string,
    input: string,
    output: string,
    judgeResult: JudgeResult
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
        dataset_id: dataset.id,
      });
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

  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    thinking: NO_THINKING,
    messages: [{ role: "user", content: optimizationPrompt }],
  });

  const parsed = parseJsonBlock<Record<string, unknown>>(
    messageText(message),
    "object"
  );
  if (!parsed || typeof parsed.prompt !== "string") {
    throw new Error("Failed to generate optimization");
  }

  return {
    prompt: parsed.prompt,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    changes: toStringArray(parsed.changes),
  };
}
