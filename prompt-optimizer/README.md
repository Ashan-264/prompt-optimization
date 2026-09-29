# Prompt Optimizer

A Next.js application for testing and optimizing AI prompts using multiple evaluation methods powered by Claude Sonnet.

## Features

### 1. **Chat Mode**

- Interactive chat interface with Claude Sonnet
- Streaming responses for real-time interaction
- Message history management

### 2. **Prompt Testing Suite**

Four evaluation methods:

#### **Dataset Tests (LangSmith Integration)**

- Run prompts against predefined datasets (General, Creative, Analytical)
- Automated quality evaluation using Claude as judge
- Optional LangSmith logging for tracing and monitoring
- Detailed test results with pass/fail status and scoring

#### **Braintrust Evaluation** 🧠

- Generates a synthetic test dataset with Gemini, then scores every case
- Four metrics per test case: Factuality, Battle, JSON validity, and Tone
- Suggests targeted prompt improvements for the cases that fail
- Streams progress as the evaluation runs

#### **LangSmith Optimization**

- Generates a test dataset, scores it against a rubric you confirm
- Pushes failing cases to a LangSmith dataset
- Rewrites the prompt from the failure patterns, then A/B tests the rewrite

#### **LLM Judge Evaluation**

- Blind two-stage evaluation process
- Scores prompts on 4 criteria:
  - Clarity (1-5)
  - Accuracy (1-5)
  - Helpfulness (1-5)
  - Completeness (1-5)
- Detailed reasoning for each score
- Overall quality assessment

## Getting Started

### Prerequisites

- Node.js 18+
- Anthropic API key (plus a Gemini and LangSmith key for the dataset-generating
  evaluations - see the environment variables below)

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file with your API keys:

```bash
# Required - every evaluation runs the prompt and/or judges it with Claude
ANTHROPIC_API_KEY=your_anthropic_api_key

# Required for Braintrust Eval and LangSmith Optimization (synthetic datasets)
GEMINI_API_KEY=your_gemini_api_key            # Get from: https://aistudio.google.com/apikey

# Required for LangSmith Optimization; also enables tracing for Dataset Tests
LANGSMITH_API_KEY=your_langsmith_api_key      # Get from: https://smith.langchain.com/settings

# Optional - used only as a fallback when Gemini requests fail
GROQ_API_KEY=your_groq_api_key                # Get from: https://console.groq.com/keys
```

4. Run the development server:

```bash
npm run dev
```

5. Open [http://localhost:3000](http://localhost:3000) in your browser

## Usage

### Chat Mode

1. Select "Chat" mode
2. Type your message and press Enter or click Send
3. View streaming responses from Claude

### Prompt Testing Mode

1. Select "Prompt Tester" mode
2. Choose a dataset (General, Creative, or Analytical)
3. Enter your prompt (use `{{input}}` as a placeholder for test inputs)
4. Choose your evaluation method:
   - **Run Dataset Tests**: Standard evaluation with LangSmith logging
   - **Braintrust Eval**: Synthetic dataset scored on four metrics, plus
     suggested prompt improvements
   - **LLM Judge**: Comprehensive blind evaluation with detailed criteria
   - **LangSmith Optimization**: Rubric-driven rewrite of the prompt, A/B
     tested against the original

### Example Prompt

```
You are a helpful AI assistant. Answer this question clearly and concisely: {{input}}
```

## Technology Stack

- **Next.js 16.1.1**: React framework with App Router
- **Anthropic SDK**: Claude API integration
- **LangSmith**: Prompt tracing and experiment tracking
- **Braintrust**: Advanced prompt evaluation and logging
- **React 19.2.3**: UI framework
- **TypeScript**: Type safety
- **Tailwind CSS 4**: Styling

## API Routes

- `/api/chat`: Streaming chat with Claude
- `/api/prompt-test`: Dataset-based testing with LangSmith
- `/api/braintrust-eval`: Synthetic-dataset evaluation across four metrics
- `/api/llm-judge`: Blind LLM judge evaluation
- `/api/langsmith-optimize`: Rubric-driven optimization with an A/B rerun
- `/api/langsmith-prompts`: Lists prompts from the LangSmith Prompt Hub

## Evaluation Metrics

### Dataset Tests (LangSmith)

- Custom Claude-based quality assessment
- The judge decides pass/fail per case
- Metrics: Overall quality score (0-10)

### Braintrust Evaluation

Each metric is scored 0 or 1, and the overall score is their average:

- **Factuality**: Consistency with the expected answer
- **Battle**: Quality and helpfulness versus the reference answer
- **JSON validity**: Parses as JSON when the test case expects JSON
- **Tone**: Matches the tone expected by the test case
- Pass threshold: 80% overall score

### LLM Judge

- **Clarity**: How easy to understand (1-5)
- **Accuracy**: Information correctness (1-5)
- **Helpfulness**: Practical value (1-5)
- **Completeness**: Thoroughness (1-5)
- **Overall Score**: Average of all criteria

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Anthropic API](https://docs.anthropic.com/)
- [LangSmith](https://docs.smith.langchain.com/)
- [Braintrust](https://www.braintrust.dev/docs)

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
