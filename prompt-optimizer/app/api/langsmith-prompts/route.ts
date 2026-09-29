import { NextRequest, NextResponse } from "next/server";
import { Client } from "langsmith";

const langsmithClient = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
});

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TIMEOUT_MS = 10_000;

// Rejects if the wrapped promise has not settled by the deadline, and always
// clears its timer so a settled request leaves nothing pending.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Request timeout")), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function GET(request: NextRequest) {
  try {
    if (!process.env.LANGSMITH_API_KEY) {
      return NextResponse.json(
        { error: "LangSmith API key not configured" },
        { status: 400 }
      );
    }

    // Get query parameters
    const searchParams = request.nextUrl.searchParams;
    const requestedLimit = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAX_LIMIT)
        : DEFAULT_LIMIT;

    // listPrompts() returns an async iterator, not a promise. Racing the
    // iterator itself against a timer resolved immediately, so the pagination
    // below was completely unguarded. Each page fetch gets the deadline.
    const iterator = langsmithClient.listPrompts()[Symbol.asyncIterator]();
    const prompts = [];
    const deadline = Date.now() + TIMEOUT_MS;

    while (prompts.length < limit) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Request timeout");

      const next = await withTimeout(iterator.next(), remaining);
      if (next.done) break;
      prompts.push(next.value);
    }

    return NextResponse.json({
      success: true,
      prompts,
      count: prompts.length,
    });
  } catch (error) {
    console.error("Error fetching LangSmith prompts:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch prompts",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
