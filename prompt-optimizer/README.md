# Prompt Optimizer

A Next.js application for testing and optimizing AI prompts using multiple evaluation methods powered by Claude Sonnet 4.

## Features

### 1. **Chat Mode**

- Interactive chat interface with Claude Sonnet 4
- Streaming responses for real-time interaction
- Message history management

### 2. **Prompt Testing Suite**

Three powerful evaluation methods:

#### **Dataset Tests (LangSmith Integration)**

- Run prompts against predefined datasets (General, Creative, Analytical)
- Automated quality evaluation using Claude as judge
- Optional LangSmith logging for tracing and monitoring
- Detailed test results with pass/fail status and scoring

#### **Braintrust Evaluation** 🧠 NEW

- Advanced prompt evaluation with Factuality and QA Accuracy scoring
- Compares outputs against expected answer characteristics
- Optional Braintrust platform logging for experiment tracking
- Dual-metric scoring system (Factuality + QA Accuracy)

#### **LLM Judge Evaluation**

- Blind two-stage evaluation process
- Scores prompts on 4 criteria:
  - Clarity (0-5)
  - Accuracy (0-5)
  - Helpfulness (0-5)
  - Completeness (0-5)
- Detailed reasoning for each score
- Overall quality assessment

## Getting Started

### Prerequisites

- Node.js 18+
- Anthropic API key

### Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

3. Create a `.env.local` file with your API keys:

```bash
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional - for enhanced logging and tracking
LANGSMITH_API_KEY=your_langsmith_api_key      # Get from: https://smith.langchain.com/settings
BRAINTRUST_API_KEY=your_braintrust_api_key    # Get from: https://www.braintrust.dev/app/settings
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
   - **Braintrust Eval**: Advanced factuality and QA accuracy scoring
   - **LLM Judge Evaluation**: Comprehensive blind evaluation with detailed criteria

### Example Prompt

```
You are a helpful AI assistant. Answer this question clearly and concisely: {{input}}
```

## Technology Stack

- **Next.js 16.1.1**: React framework with App Router
- **Anthropic SDK**: Claude Sonnet 4 API integration
- **LangSmith**: Prompt tracing and experiment tracking
- **Braintrust**: Advanced prompt evaluation and logging
- **React 19.2.3**: UI framework
- **TypeScript**: Type safety
- **Tailwind CSS 4**: Styling

## API Routes

- `/api/chat`: Streaming chat with Claude
- `/api/prompt-test`: Dataset-based testing with LangSmith
- `/api/braintrust-eval`: Braintrust evaluation with dual scoring
- `/api/llm-judge`: Blind LLM judge evaluation

## Evaluation Metrics

### Dataset Tests (LangSmith)

- Custom Claude-based quality assessment
- Pass threshold: 70% score
- Metrics: Overall quality score (0-10)

### Braintrust Evaluation

- **Factuality Score (0-100%)**: Measures factual consistency
- **QA Accuracy Score (0-100%)**: Measures answer correctness
- **Combined Score**: Average of both metrics
- Pass threshold: 70% combined score

### LLM Judge

- **Clarity**: How easy to understand (0-5)
- **Accuracy**: Information correctness (0-5)
- **Helpfulness**: Practical value (0-5)
- **Completeness**: Thoroughness (0-5)
- **Overall Score**: Average of all criteria

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
- [Anthropic API](https://docs.anthropic.com/)
- [LangSmith](https://docs.smith.langchain.com/)
- [Braintrust](https://www.braintrust.dev/docs)

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
