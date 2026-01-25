import { NextRequest, NextResponse } from "next/server";
import { Client } from "langsmith";

const langsmithClient = new Client({
  apiKey: process.env.LANGSMITH_API_KEY,
});

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
    const limit = parseInt(searchParams.get("limit") || "20");
    const offset = parseInt(searchParams.get("offset") || "0");

    // Fetch prompts from LangSmith with timeout
    const promptsPromise = langsmithClient.listPrompts({
      limit,
      offset,
    });

    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout")), 10000)
    );

    const promptsResponse = await Promise.race([
      promptsPromise,
      timeoutPromise,
    ]);

    // Convert to array - listPrompts may return an iterator or object
    let promptsArray: any[] = [];
    if (promptsResponse) {
      if (Array.isArray(promptsResponse)) {
        promptsArray = promptsResponse;
      } else if (Symbol.asyncIterator in Object(promptsResponse)) {
        // Handle async iterator with limit to prevent infinite loops
        let count = 0;
        const maxItems = limit || 100;
        for await (const prompt of promptsResponse as any) {
          if (count >= maxItems) break;
          promptsArray.push(prompt);
          count++;
        }
      } else if (
        typeof promptsResponse === "object" &&
        "prompts" in promptsResponse
      ) {
        // Handle object with prompts property
        promptsArray = Array.isArray((promptsResponse as any).prompts)
          ? (promptsResponse as any).prompts
          : [];
      }
    }

    return NextResponse.json({
      success: true,
      prompts: promptsArray,
      count: promptsArray.length,
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
