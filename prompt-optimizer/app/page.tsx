"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface TestResult {
  input: string;
  output: string;
  passed?: boolean;
  score?: number;
  feedback?: string;
  expected?: string;
  factuality_score?: number;
  qa_score?: number;
  scores?: {
    factuality: number;
    battle: number;
    jsonValidity: number;
    tone: number;
    overall: number;
  };
  metadata?: {
    expectedTone?: string;
    expectsJSON?: boolean;
    category?: string;
    [key: string]: any;
  };
}

interface ImprovedPrompt {
  prompt: string;
  reasoning: string;
  fixes: string[];
}

interface ProcessLog {
  timestamp: string;
  step: string;
  status: "running" | "completed" | "error";
  details?: string;
}

interface PromptEvaluation {
  prompt: string;
  dataset?: string;
  summary: {
    total_tests: number;
    passed_tests: number;
    failed_tests?: number;
    success_rate: string;
    average_score: string;
  };
  results: TestResult[];
  logs?: ProcessLog[];
  stats?: {
    total_assertions: number;
    passed_assertions: number;
    failed_assertions: number;
  };
  improvedPrompts?: ImprovedPrompt[];
  syntheticDataset?: any[];
  braintrust_enabled?: boolean;
}

interface LLMJudgeResult {
  prompt: string;
  ai_response: string;
  evaluation: {
    clarity: number;
    accuracy: number;
    helpfulness: number;
    completeness: number;
    reasoning: {
      clarity: string;
      accuracy: string;
      helpfulness: string;
      completeness: string;
    };
    overall_score: number;
  };
}

type Mode = "chat" | "prompt-test";

export default function Home() {
  const [mode, setMode] = useState<Mode>("chat");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [evaluation, setEvaluation] = useState<PromptEvaluation | null>(null);
  const [braintrustEvaluation, setBraintrustEvaluation] =
    useState<PromptEvaluation | null>(null);
  const [processingLogs, setProcessingLogs] = useState<ProcessLog[]>([]);
  const [llmJudgeResult, setLlmJudgeResult] = useState<LLMJudgeResult | null>(
    null
  );
  const [dataset, setDataset] = useState<string>("general");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const scrollLogsToBottom = () => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    scrollLogsToBottom();
  }, [processingLogs]);

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { role: "user", content: input };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      if (!response.ok) throw new Error("Failed to send message");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = "";

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              if (data === "[DONE]") continue;

              try {
                const parsed = JSON.parse(data);
                if (parsed.text) {
                  assistantMessage += parsed.text;
                  setMessages([
                    ...newMessages,
                    { role: "assistant", content: assistantMessage },
                  ]);
                }
              } catch (e) {
                // Skip invalid JSON
              }
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content: "Sorry, there was an error processing your request.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const testPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    setIsLoading(true);
    setEvaluation(null);

    try {
      const response = await fetch("/api/prompt-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input, dataset }),
      });

      if (!response.ok) throw new Error("Failed to evaluate prompt");

      const data = await response.json();
      if (data.success && data.evaluation) {
        setEvaluation(data.evaluation);
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Failed to evaluate prompt. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const runLLMJudge = async () => {
    if (!input.trim() || isLoading) return;

    setIsLoading(true);
    setLlmJudgeResult(null);

    try {
      const response = await fetch("/api/llm-judge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input }),
      });

      if (!response.ok) throw new Error("Failed to run LLM judge");

      const data = await response.json();
      if (data.success) {
        setLlmJudgeResult(data);
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Failed to run LLM judge evaluation. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const runBraintrustEval = async () => {
    if (!input.trim() || isLoading) return;

    setIsLoading(true);
    setBraintrustEvaluation(null);
    setProcessingLogs([]);

    try {
      const response = await fetch("/api/braintrust-eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input, dataset }),
      });

      if (!response.ok) throw new Error("Failed to run Braintrust evaluation");

      // Handle SSE stream
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error("No response body");
      }

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "log") {
                setProcessingLogs((prev) => [...prev, data.log]);
              } else if (data.type === "complete") {
                setBraintrustEvaluation(data.evaluation);
              } else if (data.type === "error") {
                throw new Error(data.error || "Evaluation failed");
              }
            } catch (e) {
              console.error("Failed to parse SSE data:", e);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error:", error);
      alert("Failed to run Braintrust evaluation. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-zinc-900">
      <main className="flex h-screen w-full max-w-6xl flex-col bg-white dark:bg-zinc-800">
        {/* Header */}
        <div className="border-b border-zinc-200 dark:border-zinc-700 p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
              Prompt Optimizer
            </h1>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setMode("chat");
                  setEvaluation(null);
                }}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  mode === "chat"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
                }`}
              >
                Claude Chat
              </button>
              <button
                onClick={() => {
                  setMode("prompt-test");
                  setMessages([]);
                }}
                className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                  mode === "prompt-test"
                    ? "bg-blue-600 text-white"
                    : "bg-zinc-100 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-600"
                }`}
              >
                Prompt Tester
              </button>
            </div>
          </div>
        </div>

        {mode === "chat" ? (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="flex h-full items-center justify-center text-zinc-400">
                  Send a message to start chatting with Claude
                </div>
              )}
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`flex ${
                    message.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-2 ${
                      message.role === "user"
                        ? "bg-blue-600 text-white"
                        : "bg-zinc-100 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-50"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                </div>
              ))}
              {isLoading && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] rounded-lg px-4 py-2 bg-zinc-100 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-50">
                    <p>Thinking...</p>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input */}
            <form
              onSubmit={sendMessage}
              className="border-t border-zinc-200 dark:border-zinc-700 p-4"
            >
              <div className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Type your message..."
                  disabled={isLoading}
                  className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-4 py-2 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isLoading || !input.trim()}
                  className="rounded-lg bg-blue-600 px-6 py-2 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  Send
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            {/* Prompt Tester Interface */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="max-w-4xl mx-auto space-y-6">
                <div>
                  <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50 mb-2">
                    Test Your Prompt with Promptfoo
                  </h2>
                  <p className="text-zinc-600 dark:text-zinc-400 mb-4">
                    Run your prompt against test datasets and see how it
                    performs across multiple scenarios.
                  </p>
                  <form onSubmit={testPrompt} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
                        Select Dataset
                      </label>
                      <select
                        value={dataset}
                        onChange={(e) => setDataset(e.target.value)}
                        className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-4 py-2 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <option value="general">
                          General Questions (4 tests)
                        </option>
                        <option value="creative">
                          Creative Writing (3 tests)
                        </option>
                        <option value="analytical">
                          Analytical Tasks (3 tests)
                        </option>
                      </select>
                    </div>
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="Enter your prompt here... Use {{input}} as a variable placeholder."
                      disabled={isLoading}
                      rows={6}
                      className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 px-4 py-3 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 resize-none"
                    />
                    <div className="flex gap-3">
                      <button
                        type="submit"
                        disabled={isLoading || !input.trim()}
                        className="flex-1 rounded-lg bg-blue-600 px-6 py-3 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isLoading ? "Running Tests..." : "Run Dataset Tests"}
                      </button>
                      <button
                        type="button"
                        onClick={runBraintrustEval}
                        disabled={isLoading || !input.trim()}
                        className="flex-1 rounded-lg bg-green-600 px-6 py-3 text-white font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isLoading ? "Evaluating..." : "Braintrust Eval"}
                      </button>
                      <button
                        type="button"
                        onClick={runLLMJudge}
                        disabled={isLoading || !input.trim()}
                        className="flex-1 rounded-lg bg-purple-600 px-6 py-3 text-white font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {isLoading ? "Evaluating..." : "LLM Judge Evaluation"}
                      </button>
                    </div>
                  </form>
                </div>

                {llmJudgeResult && (
                  <div className="space-y-6">
                    {/* AI Response */}
                    <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-700">
                      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">
                        AI Response
                      </h3>
                      <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg p-4 border border-zinc-200 dark:border-zinc-700">
                        <p className="text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">
                          {llmJudgeResult.ai_response}
                        </p>
                      </div>
                    </div>

                    {/* Judge Evaluation */}
                    <div className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-lg p-6 border border-purple-200 dark:border-purple-800">
                      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
                        <span className="text-purple-600 dark:text-purple-400">
                          ⚖️
                        </span>
                        LLM Judge Evaluation
                      </h3>

                      {/* Overall Score */}
                      <div className="mb-6 text-center">
                        <div className="text-5xl font-bold text-purple-600 dark:text-purple-400 mb-2">
                          {llmJudgeResult.evaluation.overall_score.toFixed(1)}/5
                        </div>
                        <div className="text-sm text-zinc-600 dark:text-zinc-400">
                          Overall Quality Score
                        </div>
                      </div>

                      {/* Individual Scores */}
                      <div className="grid grid-cols-2 gap-4 mb-6">
                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              Clarity
                            </span>
                            <span className="text-xl font-bold text-purple-600 dark:text-purple-400">
                              {llmJudgeResult.evaluation.clarity}
                            </span>
                          </div>
                          <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-600 dark:bg-purple-500"
                              style={{
                                width: `${
                                  (llmJudgeResult.evaluation.clarity / 5) * 100
                                }%`,
                              }}
                            />
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">
                            {llmJudgeResult.evaluation.reasoning.clarity}
                          </p>
                        </div>

                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              Accuracy
                            </span>
                            <span className="text-xl font-bold text-purple-600 dark:text-purple-400">
                              {llmJudgeResult.evaluation.accuracy}
                            </span>
                          </div>
                          <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-600 dark:bg-purple-500"
                              style={{
                                width: `${
                                  (llmJudgeResult.evaluation.accuracy / 5) * 100
                                }%`,
                              }}
                            />
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">
                            {llmJudgeResult.evaluation.reasoning.accuracy}
                          </p>
                        </div>

                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              Helpfulness
                            </span>
                            <span className="text-xl font-bold text-purple-600 dark:text-purple-400">
                              {llmJudgeResult.evaluation.helpfulness}
                            </span>
                          </div>
                          <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-600 dark:bg-purple-500"
                              style={{
                                width: `${
                                  (llmJudgeResult.evaluation.helpfulness / 5) *
                                  100
                                }%`,
                              }}
                            />
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">
                            {llmJudgeResult.evaluation.reasoning.helpfulness}
                          </p>
                        </div>

                        <div className="bg-white dark:bg-zinc-900 rounded-lg p-4 border border-purple-200 dark:border-purple-800">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                              Completeness
                            </span>
                            <span className="text-xl font-bold text-purple-600 dark:text-purple-400">
                              {llmJudgeResult.evaluation.completeness}
                            </span>
                          </div>
                          <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-purple-600 dark:bg-purple-500"
                              style={{
                                width: `${
                                  (llmJudgeResult.evaluation.completeness / 5) *
                                  100
                                }%`,
                              }}
                            />
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-2">
                            {llmJudgeResult.evaluation.reasoning.completeness}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {evaluation && (
                  <div className="space-y-6">
                    {/* Summary Stats */}
                    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-lg p-6 border border-blue-200 dark:border-blue-800">
                      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">
                        Test Summary
                      </h3>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div className="text-center">
                          <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                            {evaluation.summary.success_rate}%
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                            Success Rate
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                            {evaluation.summary.passed_tests}/
                            {evaluation.summary.total_tests}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                            Tests Passed
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
                            {evaluation.summary.average_score}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                            Avg Score (0-10)
                          </div>
                        </div>
                        <div className="text-center">
                          <div className="text-3xl font-bold text-indigo-600 dark:text-indigo-400">
                            {evaluation.summary.total_tests}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                            Total Tests
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Test Results */}
                    <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-700">
                      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">
                        Individual Test Results
                      </h3>
                      <div className="space-y-4">
                        {evaluation.results.map((result, idx) => (
                          <div
                            key={idx}
                            className={`border rounded-lg p-4 ${
                              result.passed
                                ? "border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10"
                                : "border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-900/10"
                            }`}
                          >
                            <div className="flex items-start justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`text-lg ${
                                    result.passed
                                      ? "text-green-600 dark:text-green-400"
                                      : "text-red-600 dark:text-red-400"
                                  }`}
                                >
                                  {result.passed ? "✓" : "✗"}
                                </span>
                                <span className="font-medium text-zinc-900 dark:text-zinc-50">
                                  Test {idx + 1}
                                </span>
                              </div>
                              <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
                                Score: {(result.score * 10).toFixed(1)}/10
                              </span>
                            </div>
                            <div className="ml-7 space-y-2">
                              <div>
                                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                  Input:
                                </span>
                                <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1">
                                  {result.input}
                                </p>
                              </div>
                              <div>
                                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                  Output:
                                </span>
                                <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 bg-white dark:bg-zinc-800 p-2 rounded">
                                  {result.output || "No output"}
                                </p>
                              </div>
                              {result.feedback && (
                                <div>
                                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                    Feedback:
                                  </span>
                                  <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 italic">
                                    {result.feedback}
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Assertions Stats */}
                    <div className="bg-zinc-50 dark:bg-zinc-900/50 rounded-lg p-6 border border-zinc-200 dark:border-zinc-700">
                      <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-3">
                        Assertion Statistics
                      </h3>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                            {evaluation.stats.total_assertions}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400">
                            Total Assertions
                          </div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                            {evaluation.stats.passed_assertions}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400">
                            Passed
                          </div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
                            {evaluation.stats.failed_assertions}
                          </div>
                          <div className="text-sm text-zinc-600 dark:text-zinc-400">
                            Failed
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Braintrust Evaluation Results */}
                {(braintrustEvaluation || processingLogs.length > 0) && (
                  <div className="space-y-6">
                    {/* Processing Logs */}
                    {processingLogs.length > 0 && (
                      <div className="bg-zinc-50 dark:bg-zinc-900/50 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
                        <div className="bg-zinc-100 dark:bg-zinc-800 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
                          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                            Processing Log
                            {isLoading && (
                              <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                            )}
                          </h3>
                        </div>
                        <div className="p-4 max-h-64 overflow-y-auto font-mono text-xs space-y-1">
                          {processingLogs.map((log, idx) => (
                            <div
                              key={idx}
                              className="flex items-start gap-2 text-zinc-700 dark:text-zinc-300"
                            >
                              <span className="text-zinc-400 dark:text-zinc-500 shrink-0">
                                {new Date(log.timestamp).toLocaleTimeString()}
                              </span>
                              <span
                                className={`shrink-0 ${
                                  log.status === "completed"
                                    ? "text-green-600 dark:text-green-400"
                                    : log.status === "error"
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-blue-600 dark:text-blue-400"
                                }`}
                              >
                                {log.status === "completed"
                                  ? "✓"
                                  : log.status === "error"
                                  ? "✗"
                                  : "▸"}
                              </span>
                              <span>
                                <span className="font-semibold">
                                  {log.step}
                                </span>
                                {log.details && (
                                  <span className="text-zinc-500 dark:text-zinc-400">
                                    {" "}
                                    - {log.details}
                                  </span>
                                )}
                              </span>
                            </div>
                          ))}
                          <div ref={logsEndRef} />
                        </div>
                      </div>
                    )}
                    {/* Summary Stats */}
                    {braintrustEvaluation && (
                      <div className="bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 rounded-lg p-6 border border-green-200 dark:border-green-800">
                        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-2 flex items-center gap-2">
                          <span className="text-green-600 dark:text-green-400">
                            🧠
                          </span>
                          Braintrust AI-Powered Evaluation
                        </h3>
                        <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-4">
                          Generated {braintrustEvaluation.summary.total_tests}{" "}
                          synthetic test cases with Gemini Flash 2.5
                        </p>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                          <div className="text-center">
                            <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                              {braintrustEvaluation.summary.success_rate}%
                            </div>
                            <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                              Success Rate
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">
                              {braintrustEvaluation.summary.passed_tests}/
                              {braintrustEvaluation.summary.total_tests}
                            </div>
                            <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                              Tests Passed
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-3xl font-bold text-red-600 dark:text-red-400">
                              {braintrustEvaluation.summary.failed_tests || 0}
                            </div>
                            <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                              Tests Failed
                            </div>
                          </div>
                          <div className="text-center">
                            <div className="text-3xl font-bold text-teal-600 dark:text-teal-400">
                              {braintrustEvaluation.summary.average_score}
                            </div>
                            <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                              Avg Score
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Test Results with Detailed Scores */}
                    {braintrustEvaluation && (
                      <div className="bg-white dark:bg-zinc-900 rounded-lg p-6 border border-zinc-200 dark:border-zinc-700">
                        <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4">
                          Test Results (4 Metrics: Factuality, Battle, JSON,
                          Tone)
                        </h3>
                        <div className="space-y-4">
                          {braintrustEvaluation.results.map((result, idx) => {
                            const overallScore = result.scores?.overall ?? 0;
                            const isPassed = overallScore >= 0.8;

                            return (
                              <details
                                key={idx}
                                className={`border rounded-lg ${
                                  isPassed
                                    ? "border-green-200 dark:border-green-800 bg-green-50/30 dark:bg-green-900/10"
                                    : "border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-900/10"
                                }`}
                              >
                                <summary className="cursor-pointer p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 rounded-lg">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <span
                                        className={`text-2xl ${
                                          isPassed
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-red-600 dark:text-red-400"
                                        }`}
                                      >
                                        {isPassed ? "✓" : "✗"}
                                      </span>
                                      <div>
                                        <div className="font-medium text-zinc-900 dark:text-zinc-50">
                                          Test {idx + 1}:{" "}
                                          {result.input.substring(0, 50)}...
                                        </div>
                                        {result.metadata?.category && (
                                          <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                            Category: {result.metadata.category}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <div className="flex items-center gap-4">
                                      <div className="text-right">
                                        <div className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                                          {(overallScore * 100).toFixed(0)}%
                                        </div>
                                        <div className="text-xs text-zinc-500 dark:text-zinc-400">
                                          Overall
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </summary>

                                <div className="px-4 pb-4 space-y-4">
                                  {/* Score Breakdown */}
                                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                                    <div className="bg-white dark:bg-zinc-800 rounded p-3 text-center border border-zinc-200 dark:border-zinc-700">
                                      <div
                                        className={`text-2xl font-bold ${
                                          result.scores?.factuality === 1
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-red-600 dark:text-red-400"
                                        }`}
                                      >
                                        {result.scores?.factuality === 1
                                          ? "✓"
                                          : "✗"}
                                      </div>
                                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                                        Factuality
                                      </div>
                                    </div>
                                    <div className="bg-white dark:bg-zinc-800 rounded p-3 text-center border border-zinc-200 dark:border-zinc-700">
                                      <div
                                        className={`text-2xl font-bold ${
                                          result.scores?.battle === 1
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-red-600 dark:text-red-400"
                                        }`}
                                      >
                                        {result.scores?.battle === 1
                                          ? "✓"
                                          : "✗"}
                                      </div>
                                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                                        Battle
                                      </div>
                                    </div>
                                    <div className="bg-white dark:bg-zinc-800 rounded p-3 text-center border border-zinc-200 dark:border-zinc-700">
                                      <div
                                        className={`text-2xl font-bold ${
                                          result.scores?.jsonValidity === 1
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-red-600 dark:text-red-400"
                                        }`}
                                      >
                                        {result.scores?.jsonValidity === 1
                                          ? "✓"
                                          : "✗"}
                                      </div>
                                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                                        JSON
                                      </div>
                                    </div>
                                    <div className="bg-white dark:bg-zinc-800 rounded p-3 text-center border border-zinc-200 dark:border-zinc-700">
                                      <div
                                        className={`text-2xl font-bold ${
                                          result.scores?.tone === 1
                                            ? "text-green-600 dark:text-green-400"
                                            : "text-red-600 dark:text-red-400"
                                        }`}
                                      >
                                        {result.scores?.tone === 1 ? "✓" : "✗"}
                                      </div>
                                      <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-1">
                                        Tone
                                      </div>
                                    </div>
                                  </div>

                                  {/* Input */}
                                  <div>
                                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                      Input:
                                    </span>
                                    <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1">
                                      {result.input}
                                    </p>
                                  </div>

                                  {/* Expected */}
                                  {result.expected && (
                                    <div>
                                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                        Expected Output:
                                      </span>
                                      <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 italic">
                                        {result.expected}
                                      </p>
                                    </div>
                                  )}

                                  {/* Actual Output */}
                                  <div>
                                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                      Actual Output:
                                    </span>
                                    <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 bg-zinc-50 dark:bg-zinc-800 p-3 rounded border border-zinc-200 dark:border-zinc-700">
                                      {result.output || "No output"}
                                    </p>
                                  </div>

                                  {/* Metadata */}
                                  {result.metadata && (
                                    <div className="flex flex-wrap gap-2">
                                      {result.metadata.expectedTone && (
                                        <span className="text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 px-2 py-1 rounded">
                                          Tone: {result.metadata.expectedTone}
                                        </span>
                                      )}
                                      {result.metadata.expectsJSON && (
                                        <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-1 rounded">
                                          Expects JSON
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Improved Prompt Suggestions */}
                    {braintrustEvaluation &&
                      braintrustEvaluation.improvedPrompts &&
                      braintrustEvaluation.improvedPrompts.length > 0 && (
                        <div className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-lg p-6 border border-purple-200 dark:border-purple-800">
                          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 mb-4 flex items-center gap-2">
                            <span className="text-purple-600 dark:text-purple-400">
                              💡
                            </span>
                            Suggested Prompt Improvements (Claude Sonnet 4)
                          </h3>
                          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
                            Based on{" "}
                            {braintrustEvaluation.summary.failed_tests || 0}{" "}
                            failing test case(s), here are targeted
                            improvements:
                          </p>
                          <div className="space-y-4">
                            {braintrustEvaluation.improvedPrompts.map(
                              (improved, idx) => (
                                <details
                                  key={idx}
                                  className="bg-white dark:bg-zinc-900 rounded-lg border border-purple-200 dark:border-purple-800"
                                >
                                  <summary className="cursor-pointer p-4 hover:bg-purple-50 dark:hover:bg-purple-900/10 rounded-lg">
                                    <div className="flex items-center gap-3">
                                      <span className="text-purple-600 dark:text-purple-400 font-bold text-lg">
                                        #{idx + 1}
                                      </span>
                                      <div className="font-medium text-zinc-900 dark:text-zinc-50">
                                        Improved Prompt Version {idx + 1}
                                      </div>
                                    </div>
                                  </summary>
                                  <div className="px-4 pb-4 space-y-4">
                                    {/* Improved Prompt */}
                                    <div>
                                      <span className="text-xs font-medium text-purple-600 dark:text-purple-400 uppercase">
                                        Improved Prompt:
                                      </span>
                                      <div className="mt-2 bg-purple-50 dark:bg-purple-900/20 p-4 rounded border border-purple-200 dark:border-purple-800">
                                        <pre className="text-sm text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap font-mono">
                                          {improved.prompt}
                                        </pre>
                                      </div>
                                    </div>

                                    {/* Reasoning */}
                                    <div>
                                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                        Reasoning:
                                      </span>
                                      <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1">
                                        {improved.reasoning}
                                      </p>
                                    </div>

                                    {/* Specific Fixes */}
                                    <div>
                                      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase">
                                        Specific Fixes:
                                      </span>
                                      <ul className="mt-2 space-y-1">
                                        {improved.fixes.map((fix, fixIdx) => (
                                          <li
                                            key={fixIdx}
                                            className="text-sm text-zinc-700 dark:text-zinc-300 flex items-start gap-2"
                                          >
                                            <span className="text-green-600 dark:text-green-400 mt-0.5">
                                              ✓
                                            </span>
                                            <span>{fix}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  </div>
                                </details>
                              )
                            )}
                          </div>
                        </div>
                      )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
