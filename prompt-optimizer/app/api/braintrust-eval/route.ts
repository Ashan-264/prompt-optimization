import { NextRequest } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
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

interface TestCase {
  input: string;
  expected: string;
  metadata?: {
    expectedTone?: string;
    expectsJSON?: boolean;
    minLength?: number;
    mustContain?: string[];
    [key: string]: string | number | boolean | string[] | undefined;
  };
}

interface TestResult {
  input: string;
  output: string;
  expected: string;
  scores: {
    factuality: number;
    battle: number;
    jsonValidity: number;
    tone: number;
    overall: number;
  };
  metadata?: TestCase["metadata"];
}

// The generator models are free-form, so anything missing the fields the rest
// of the pipeline reads (input.substring, expected, metadata lookups) has to be
// dropped here rather than crashing the run mid-way.
function normalizeTestCases(value: unknown): TestCase[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): TestCase[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.input !== "string" || !candidate.input.trim()) {
      return [];
    }

    return [
      {
        input: candidate.input,
        expected:
          typeof candidate.expected === "string" ? candidate.expected : "",
        metadata:
          typeof candidate.metadata === "object" && candidate.metadata !== null
            ? (candidate.metadata as TestCase["metadata"])
            : undefined,
      },
    ];
  });
}

// Generate synthetic test cases using Gemini
async function generateSyntheticDataset(prompt: string): Promise<TestCase[]> {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
  });

  const generationPrompt = `You are a test case generator for prompt evaluation. Analyze this prompt and generate 5 diverse test cases to evaluate its effectiveness.

PROMPT TO ANALYZE:
${prompt}

INSTRUCTIONS:
1. Identify the prompt type:
   - FACTUAL: Questions with verifiable answers (e.g., "What is photosynthesis?")
   - RECOMMENDATION: Requests for suggestions, lists, or options (e.g., "Suggest MTB trails", "Recommend restaurants")
   - CREATIVE: Story writing, poetry, creative content
   - TRANSFORMATION: Data processing, format conversion

2. For RECOMMENDATION prompts:
   - Expected output should describe CRITERIA, not specific items
   - Example: "Should provide 3-5 trail options with difficulty levels, locations, and brief descriptions"
   - NOT: "Should mention Trail X in Location Y"
   - Focus on structure, completeness, and helpfulness

3. For FACTUAL prompts:
   - Expected output should have verifiable facts
   - Can be specific about correct information

4. For CREATIVE prompts:
   - Expected output should describe quality attributes
   - Example: "Should be engaging, descriptive, and grammatically correct"

Return a JSON array with EXACTLY this schema:
[
  {
    "input": "The variable part that replaces {{input}} in the prompt",
    "expected": "For recommendations: describe what good output should CONTAIN (not specific answers). For facts: provide correct answer. For creative: describe quality criteria.",
    "metadata": {
      "expectedTone": "professional|casual|formal|friendly|etc (extract from prompt)",
      "expectsJSON": true|false,
      "minLength": <number>,
      "mustContain": ["keyword1", "keyword2"],
      "category": "factual|recommendation|creative|transformation",
      "promptType": "factual|recommendation|creative|transformation"
    }
  }
]

IMPORTANT:
- Set category and promptType correctly based on prompt analysis
- For recommendations, expected should be criteria-based
- Make test cases diverse and challenging
- Extract tone from the original prompt context
- Set expectsJSON to true only if prompt explicitly asks for JSON

Return ONLY the JSON array with 5 test cases, no explanation.`;

  try {
    const result = await model.generateContent(generationPrompt);
    const response = result.response.text();

    // Extract JSON from response
    const testCases = normalizeTestCases(
      parseJsonBlock<unknown>(response, "array")
    );
    if (testCases.length === 0) {
      throw new Error("Failed to parse Gemini response as JSON");
    }

    return testCases;
  } catch (geminiError) {
    console.warn("Gemini failed, falling back to Groq Llama:", geminiError);

    if (!process.env.GROQ_API_KEY) {
      throw new Error(
        "Failed to generate synthetic dataset with Gemini, and GROQ_API_KEY is not configured for fallback"
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
      parseJsonBlock<unknown>(response, "array")
    );

    if (testCases.length === 0) {
      throw new Error(
        "Failed to generate synthetic dataset with both Gemini and Groq"
      );
    }

    return testCases;
  }
}

// Run prompt with Claude
async function runPrompt(prompt: string, input: string): Promise<string> {
  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    thinking: NO_THINKING,
    messages: [{ role: "user", content: fillPrompt(prompt, input) }],
  });

  return messageText(message);
}

// Asks the judge for a bare "1" or "0" and reads the last digit it emitted.
async function scoreBinary(
  judgePrompt: string,
  label: string
): Promise<number> {
  try {
    const message = await getAnthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 50,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: judgePrompt }],
    });

    const response = messageText(message).trim();
    const match = response.match(/[01]/g);
    const lastDigit = match ? match[match.length - 1] : "0";

    return lastDigit === "1" ? 1 : 0;
  } catch (error) {
    console.error(`${label} scoring error:`, error);
    return 0;
  }
}

// Custom tone scorer using Claude
async function scoreTone(
  output: string,
  expectedTone: string
): Promise<number> {
  if (!expectedTone) return 1; // Pass if no tone specified

  return scoreBinary(
    `Does this text have a ${expectedTone} tone?

TEXT:
${output}

Answer with ONLY "1" for yes or "0" for no.`,
    "Tone"
  );
}

// Custom factuality scorer using Claude (context-aware)
async function scoreFactuality(
  output: string,
  expected: string,
  metadata?: TestCase["metadata"]
): Promise<number> {
  const promptType = metadata?.promptType || metadata?.category || "factual";

  let factualityPrompt = "";

  if (promptType === "recommendation") {
    // For recommendations, just check if output is on-topic and contains the right type of info
    factualityPrompt = `Simple yes/no: Does this output provide relevant recommendations/information that addresses the request?

OUTPUT:
${output}

REQUEST TYPE:
${expected}

If the output:
- Is on-topic and relevant
- Provides specific examples/recommendations
- Contains details and explanations

Then answer "1"

Only answer "0" if output is:
- Completely off-topic
- Just says "I don't know" or refuses
- Provides no actual information

Answer ONLY with "1" or "0":`;
  } else if (promptType === "creative") {
    // For creative content, check if it's coherent and relevant
    factualityPrompt = `Evaluate if this creative output meets the quality criteria.

OUTPUT:
${output}

QUALITY CRITERIA:
${expected}

Return "1" if output is coherent, relevant, and meets the quality bar, "0" if it's off-topic or poor quality.`;
  } else {
    // For factual content, check accuracy
    factualityPrompt = `Is this output factually consistent with the expected answer?

OUTPUT:
${output}

EXPECTED:
${expected}

Return "1" if factually consistent/correct, "0" if not.`;
  }

  return scoreBinary(factualityPrompt, "Factuality");
}

// Custom battle scorer using Claude (focus on quality, not just similarity)
async function scoreBattle(
  input: string,
  output: string,
  expected: string,
  metadata?: TestCase["metadata"]
): Promise<number> {
  const promptType = metadata?.promptType || metadata?.category || "factual";

  let battlePrompt = "";

  if (promptType === "recommendation") {
    // For recommendations, just check if it's helpful
    battlePrompt = `Simple yes/no: Is this response helpful and adequate?

USER REQUEST:
${input}

RESPONSE:
${output}

If the response:
- Directly addresses the request
- Provides specific, useful information
- Has reasonable detail

Then answer "1"

Only answer "0" if response:
- Is off-topic or irrelevant
- Is extremely vague ("there are many options")
- Refuses to help or provides no real information

Answer ONLY with "1" or "0":`;
  } else {
    // For factual/creative, compare quality
    battlePrompt = `Compare these two responses for quality and helpfulness.

INPUT: ${input}

RESPONSE A (Actual): ${output}

RESPONSE B (Reference): ${expected}

Evaluate: Is Response A at least as good as Response B in terms of accuracy, completeness, and helpfulness?
Different but equally valid approaches should pass.

Return "1" if A is as good or better, "0" only if B is clearly superior.`;
  }

  return scoreBinary(battlePrompt, "Battle");
}

// Run evaluation with custom Claude-based scorers
async function evaluateTestCase(
  testCase: TestCase,
  output: string
): Promise<TestResult["scores"]> {
  const scores = {
    factuality: 0,
    battle: 0,
    jsonValidity: 0,
    tone: 0,
    overall: 0,
  };

  try {
    // 1. Factuality Score (checks if output is factually consistent with expected)
    scores.factuality = await scoreFactuality(
      output,
      testCase.expected,
      testCase.metadata
    );

    // 2. Battle Score (compare output vs expected)
    scores.battle = await scoreBattle(
      testCase.input,
      output,
      testCase.expected,
      testCase.metadata
    );

    // 3. JSON Validity Score
    if (testCase.metadata?.expectsJSON) {
      try {
        JSON.parse(output);
        scores.jsonValidity = 1;
      } catch {
        scores.jsonValidity = 0;
      }
    } else {
      scores.jsonValidity = 1; // Pass if JSON not expected
    }

    // 4. Tone Score
    if (testCase.metadata?.expectedTone) {
      scores.tone = await scoreTone(output, testCase.metadata.expectedTone);
    } else {
      scores.tone = 1; // Pass if no tone specified
    }
  } catch (error) {
    console.error("Evaluation error:", error);
  }

  // Computed outside the try so a partially scored test still reports an
  // overall consistent with the individual scores above it.
  scores.overall =
    (scores.factuality + scores.battle + scores.jsonValidity + scores.tone) / 4;

  return scores;
}

// Get improved prompt suggestions from Claude
async function getImprovedPrompts(
  originalPrompt: string,
  failedTests: TestResult[]
): Promise<Array<{ prompt: string; reasoning: string; fixes: string[] }>> {
  const failureAnalysis = failedTests
    .map(
      (test, idx) => `
Test ${idx + 1}:
Input: ${test.input}
Expected: ${test.expected}
Got: ${test.output}
Scores: Factuality=${test.scores.factuality}, Battle=${
        test.scores.battle
      }, JSON=${test.scores.jsonValidity}, Tone=${test.scores.tone}
`
    )
    .join("\n");

  const improvementPrompt = `You are a prompt engineering expert. Analyze this prompt and its failures, then suggest 3 SMALL TARGETED IMPROVEMENTS.

ORIGINAL PROMPT:
${originalPrompt}

FAILED TEST CASES (score < 0.8):
${failureAnalysis}

INSTRUCTIONS:
Create 3 variations of the prompt with small, targeted fixes to address specific issues. Keep the core structure but improve problematic areas.

Return a JSON array:
[
  {
    "prompt": "Improved version 1",
    "reasoning": "Why this fixes the issues",
    "fixes": ["Specific fix 1", "Specific fix 2"]
  }
]

Return ONLY the JSON array.`;

  try {
    const message = await getAnthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: improvementPrompt }],
    });

    const suggestions = parseJsonBlock<unknown>(messageText(message), "array");
    if (!Array.isArray(suggestions)) return [];

    // The UI renders improved.fixes.map(...) and both text fields directly.
    return suggestions.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.prompt !== "string") return [];

      return [
        {
          prompt: candidate.prompt,
          reasoning:
            typeof candidate.reasoning === "string" ? candidate.reasoning : "",
          fixes: Array.isArray(candidate.fixes)
            ? candidate.fixes.filter(
                (fix): fix is string => typeof fix === "string"
              )
            : [],
        },
      ];
    });
  } catch (error) {
    console.error("Improvement generation error:", error);
    return [];
  }
}

export async function POST(request: NextRequest) {
  // Parse request body first
  const body = await request.json();
  const { prompt } = body;

  // "phase" rather than "step": the UI renders log.phase, so the old key left
  // every Braintrust log line without its step name.
  const logs: Array<{
    timestamp: string;
    phase: string;
    status: "running" | "completed" | "error";
    details?: string;
  }> = [];

  // Create a TransformStream for SSE
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

    // Send log as SSE
    await send({ type: "log", log });
  };

  // Start processing in the background
  (async () => {
    try {
      if (!prompt || typeof prompt !== "string") {
        await sendLog("Error", "error", "Prompt string is required");
        await send({ type: "error", error: "Prompt string is required" });
        await closeStream();
        return;
      }

      if (!process.env.GEMINI_API_KEY) {
        await sendLog("Error", "error", "GEMINI_API_KEY not configured");
        await send({ type: "error", error: "GEMINI_API_KEY not configured" });
        await closeStream();
        return;
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        await sendLog("Error", "error", "ANTHROPIC_API_KEY not configured");
        await send({ type: "error", error: "ANTHROPIC_API_KEY not configured" });
        await closeStream();
        return;
      }

      // Step 1: Generate synthetic dataset with Gemini
      await sendLog("Analyzing prompt", "running");
      await sendLog(
        "Generating synthetic dataset with Gemini Flash 2.5",
        "running"
      );

      const testCases = await generateSyntheticDataset(prompt);
      await sendLog(
        "Dataset generation complete",
        "completed",
        `Generated ${testCases.length} test cases`
      );

      // Step 2: Run evaluations
      await sendLog(
        "Running evaluations",
        "running",
        "Testing prompt against dataset"
      );
      const results: TestResult[] = [];

      for (const [index, testCase] of testCases.entries()) {
        await sendLog(
          `Evaluating test ${index + 1}/${testCases.length}`,
          "running",
          `Input: ${testCase.input.substring(0, 50)}...`
        );

        const output = await runPrompt(prompt, testCase.input);
        const scores = await evaluateTestCase(testCase, output);

        results.push({
          input: testCase.input,
          output,
          expected: testCase.expected,
          scores,
          metadata: testCase.metadata,
        });

        await sendLog(
          `Test ${index + 1} completed`,
          "completed",
          `Score: ${(scores.overall * 100).toFixed(0)}%`
        );
      }

      await sendLog(
        "All tests completed",
        "completed",
        `${results.length} tests executed`
      );

      // Step 3: Filter failing tests (score < 0.8)
      const failedTests = results.filter((r) => r.scores.overall < 0.8);

      // Step 4: Get improved prompts if there are failures
      let improvedPrompts: Array<{
        prompt: string;
        reasoning: string;
        fixes: string[];
      }> = [];

      if (failedTests.length > 0) {
        await sendLog(
          "Analyzing failures",
          "running",
          `${failedTests.length} test(s) failed - generating improvements`
        );

        improvedPrompts = await getImprovedPrompts(prompt, failedTests);

        await sendLog(
          "Improvement suggestions ready",
          "completed",
          `Generated ${improvedPrompts.length} improved prompt versions`
        );
      } else {
        await sendLog(
          "All tests passed",
          "completed",
          "No improvements needed - prompt performed well!"
        );
      }

      // Calculate stats
      const totalTests = results.length;
      const passedTests = results.filter((r) => r.scores.overall >= 0.8).length;
      // Guarded: an empty result set would otherwise report NaN throughout.
      const successRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;
      const avgScore =
        totalTests > 0
          ? results.reduce((sum, r) => sum + r.scores.overall, 0) / totalTests
          : 0;

      await sendLog(
        "Evaluation complete",
        "completed",
        `Success rate: ${successRate.toFixed(1)}%`
      );

      // Send final results
      await send({
        type: "complete",
        evaluation: {
          prompt,
          summary: {
            total_tests: totalTests,
            passed_tests: passedTests,
            failed_tests: failedTests.length,
            success_rate: successRate.toFixed(1),
            average_score: (avgScore * 100).toFixed(1),
          },
          results,
          improvedPrompts: improvedPrompts.slice(0, 3),
          syntheticDataset: testCases,
          logs,
        },
      });

      await closeStream();
    } catch (error) {
      console.error("Error in braintrust-eval API:", error);
      await sendLog(
        "Error occurred",
        "error",
        error instanceof Error ? error.message : "Unknown error"
      );

      await send({
        type: "error",
        error: "Failed to run Braintrust evaluation",
        details: error instanceof Error ? error.message : "Unknown error",
        logs,
      });
      await closeStream();
    }
  })().catch((error) => {
    // Last resort: never let the detached task reject unhandled.
    console.error("Unhandled braintrust-eval stream error:", error);
  });

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
