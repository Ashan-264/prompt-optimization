import { NextRequest, NextResponse } from "next/server";
import { Client } from "langsmith";
import { v4 as uuidv4 } from "uuid";
import {
  CLAUDE_MODEL,
  NO_THINKING,
  fillPrompt,
  getAnthropic,
  messageText,
  parseJsonBlock,
} from "../../lib/llm";

const langsmithClient = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
});

// Sample test datasets for different use cases
const SAMPLE_DATASETS = {
  general: [
    { input: "Explain quantum computing", expected_quality: "comprehensive" },
    { input: "What is photosynthesis?", expected_quality: "clear" },
    { input: "How does blockchain work?", expected_quality: "detailed" },
    { input: "Describe machine learning", expected_quality: "accessible" },
  ],
  creative: [
    { input: "Write a story about a robot", expected_quality: "creative" },
    { input: "Compose a haiku about nature", expected_quality: "poetic" },
    { input: "Create a product slogan", expected_quality: "catchy" },
  ],
  analytical: [
    { input: "Analyze climate change data", expected_quality: "analytical" },
    {
      input: "Compare two programming languages",
      expected_quality: "balanced",
    },
    { input: "Evaluate market trends", expected_quality: "data-driven" },
  ],
};

type DatasetName = keyof typeof SAMPLE_DATASETS;

const DATASET_NAMES = Object.keys(SAMPLE_DATASETS) as DatasetName[];

// Indexing SAMPLE_DATASETS with an arbitrary string reaches inherited Object
// members ("constructor", "toString", ...), which are truthy and would slip
// past a plain `|| SAMPLE_DATASETS.general` fallback.
function resolveDataset(value: unknown): DatasetName {
  return DATASET_NAMES.includes(value as DatasetName)
    ? (value as DatasetName)
    : "general";
}

interface Evaluation {
  passed: boolean;
  score: number;
  feedback: string;
}

// Run Claude with the prompt
async function runClaudePrompt(prompt: string, input: string): Promise<string> {
  const message = await getAnthropic().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    thinking: NO_THINKING,
    messages: [{ role: "user", content: fillPrompt(prompt, input) }],
  });

  return messageText(message);
}

// Use LangSmith for evaluation
async function evaluateWithLangSmith(
  output: string,
  expectedQuality: string
): Promise<Evaluation> {
  try {
    const evaluationPrompt = `Evaluate the following response for ${expectedQuality} quality.
Score from 0.0 to 1.0 where:
- 1.0 = Excellent, fully ${expectedQuality}
- 0.7-0.9 = Good, mostly ${expectedQuality}
- 0.4-0.6 = Average, somewhat ${expectedQuality}
- 0.0-0.3 = Poor, not ${expectedQuality}

Response to evaluate:
"""
${output}
"""

Return ONLY a JSON object in this format:
{"score": <number 0-1>, "passed": <boolean>, "feedback": "<brief explanation>"}`;

    const message = await getAnthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      thinking: NO_THINKING,
      messages: [{ role: "user", content: evaluationPrompt }],
    });

    const text = messageText(message);
    if (!text) {
      return { score: 0, passed: false, feedback: "Evaluation failed" };
    }

    const result = parseJsonBlock<Record<string, unknown>>(text, "object");
    if (!result) {
      return {
        score: 0,
        passed: false,
        feedback: "Could not parse evaluation",
      };
    }

    // A missing or non-numeric score would poison the running totals with NaN,
    // and the model sometimes reports "passed" as a string.
    const score = Number(result.score);
    return {
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
      passed: result.passed === true || result.passed === "true",
      feedback:
        typeof result.feedback === "string"
          ? result.feedback
          : "No feedback provided",
    };
  } catch (error) {
    console.error("Evaluation error:", error);
    return { score: 0, passed: false, feedback: "Evaluation error occurred" };
  }
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, dataset } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt string is required" },
        { status: 400 }
      );
    }

    // Select dataset
    const datasetName = resolveDataset(dataset);
    const testData = SAMPLE_DATASETS[datasetName];

    // Create a unique experiment name
    const experimentName = `prompt-test-${datasetName}-${uuidv4().slice(0, 8)}`;

    // Log to LangSmith (if API key is configured)
    const tracingEnabled = !!process.env.LANGSMITH_API_KEY;

    // Run tests
    const testResults = [];
    let passedTests = 0;
    let totalScore = 0;
    let passedAssertions = 0;
    let failedAssertions = 0;

    for (const [index, testCase] of testData.entries()) {
      try {
        const runId = uuidv4();

        // Run Claude prompt
        const output = await runClaudePrompt(prompt, testCase.input);

        // Evaluate the output
        const evaluation = await evaluateWithLangSmith(
          output,
          testCase.expected_quality
        );

        // Log to LangSmith if enabled
        if (tracingEnabled) {
          try {
            await langsmithClient.createRun({
              name: `${experimentName}-test-${index + 1}`,
              run_type: "chain",
              inputs: {
                prompt,
                input: testCase.input,
                expected_quality: testCase.expected_quality,
              },
              outputs: {
                output,
                score: evaluation.score,
                passed: evaluation.passed,
                feedback: evaluation.feedback,
              },
              id: runId,
              project_name: "prompt-optimization",
            });
          } catch (langsmithError) {
            console.warn("LangSmith logging failed:", langsmithError);
          }
        }

        const passed = evaluation.passed;
        if (passed) {
          passedTests++;
          passedAssertions++;
        } else {
          failedAssertions++;
        }

        totalScore += evaluation.score;

        testResults.push({
          input: testCase.input,
          output: output,
          passed: passed,
          score: evaluation.score,
          feedback: evaluation.feedback,
        });
      } catch (error) {
        console.error(`Test ${index + 1} error:`, error);
        testResults.push({
          input: testCase.input,
          output: "Error running test",
          passed: false,
          score: 0,
          feedback: "Test execution failed",
        });
        failedAssertions++;
      }
    }

    const totalTests = testData.length;
    const successRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 0;
    const avgScore = totalTests > 0 ? totalScore / totalTests : 0;

    return NextResponse.json({
      success: true,
      evaluation: {
        prompt,
        dataset: datasetName,
        experiment_name: experimentName,
        langsmith_enabled: tracingEnabled,
        summary: {
          total_tests: totalTests,
          passed_tests: passedTests,
          success_rate: successRate.toFixed(1),
          average_score: (avgScore * 10).toFixed(1),
        },
        results: testResults,
        stats: {
          total_assertions: passedAssertions + failedAssertions,
          passed_assertions: passedAssertions,
          failed_assertions: failedAssertions,
        },
      },
    });
  } catch (error) {
    console.error("Error in prompt-test API:", error);
    return NextResponse.json(
      {
        error: "Failed to evaluate prompt",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
