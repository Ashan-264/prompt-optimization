import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "langsmith";
import { v4 as uuidv4 } from "uuid";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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

// Run Claude with the prompt
async function runClaudePrompt(prompt: string, input: string): Promise<string> {
  const formattedPrompt = prompt.replace(/\{\{input\}\}/g, input);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: formattedPrompt }],
  });

  const textContent = message.content.find((block) => block.type === "text");
  return textContent && textContent.type === "text" ? textContent.text : "";
}

// Use LangSmith for evaluation
async function evaluateWithLangSmith(
  output: string,
  expectedQuality: string
): Promise<{ passed: boolean; score: number; feedback: string }> {
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

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: evaluationPrompt }],
    });

    const textContent = message.content.find((block) => block.type === "text");
    if (!textContent || textContent.type !== "text") {
      return { score: 0, passed: false, feedback: "Evaluation failed" };
    }

    const jsonMatch = textContent.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        score: 0,
        passed: false,
        feedback: "Could not parse evaluation",
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    return result;
  } catch (error) {
    console.error("Evaluation error:", error);
    return { score: 0, passed: false, feedback: "Evaluation error occurred" };
  }
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, dataset = "general" } = await request.json();

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt string is required" },
        { status: 400 }
      );
    }

    // Select dataset
    const testData =
      SAMPLE_DATASETS[dataset as keyof typeof SAMPLE_DATASETS] ||
      SAMPLE_DATASETS.general;

    // Create a unique experiment name
    const experimentName = `prompt-test-${dataset}-${uuidv4().slice(0, 8)}`;

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
        dataset,
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
