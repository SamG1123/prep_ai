# Interview Prep AI

A full-stack Next.js interview-preparation app built around the supplied company-wise interview-question workbook.

## Included
- Company filter with 130 unique company labels from the workbook
- Domain filter
- Full-text question search
- AI answer studio with three styles: Interviewee, Normal, Specific format
- Company-level printable PDF export
- Live MongoDB-backed question bank seeded from the bundled dataset
- Question contribution pipeline for TXT, CSV, and XLSX uploads
- LLM normalization, exact duplicate checks, similarity review, and reviewer publication
- API route for server-side Groq calls with Gemini fallback, keeping API keys out of the browser

## Run locally
```bash
npm install
cp .env.example .env.local
# add GROQ_API_KEY from https://console.groq.com/keys
npm run dev
```

The app tries Groq first (`llama-3.3-70b-versatile`) and automatically falls back to Gemini if both keys are configured. Groq and Gemini have separate free-tier quotas and rate limits, so configuring both is more reliable for large exports. Set `GROQ_MODEL` or `GEMINI_MODEL` to another model available to your keys.

For a shared deployment cache, create an Upstash Redis database and add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to the deployment environment. The API caches answers by question, company, role, domain, and style for 30 days. Redis is optional and failures fall back to normal provider generation.

Question chat sessions and the live question bank are stored in MongoDB Atlas. Add `MONGODB_URI`, `MONGODB_DB_NAME`, and a private `CHAT_RATE_LIMIT_SALT` to the server environment. The first question-bank request seeds MongoDB from `public/questions.json`; future approved contributions are served from the collection without rebuilding the app. Sessions expire after 30 days. Chat is limited to 30 user messages per session, 25 requests per client per ten-minute window, and interview-related messages only. Set `GROQ_CHAT_MODEL` or `GEMINI_CHAT_MODEL` to override the chat model independently from answer generation.

Chat uses email/password accounts stored in MongoDB Atlas with bcrypt password hashes. Add `MONGODB_URI`, `MONGODB_DB_NAME`, `NEXTAUTH_SECRET`, and `NEXTAUTH_URL` to the server environment. Auth.js users and sessions are stored in MongoDB Atlas.

Contributors can open **Contribute questions**, provide a company and optional metadata, paste one question per line, or upload TXT/CSV/XLSX. Preprocessing uses the configured Groq-first/Gemini-fallback integration. Contributions remain in a review queue until published. Configure `REVIEWER_EMAILS` as a comma-separated list of authorized account emails to enable the reviewer queue and publication actions. Exact matches and similarity scores above `0.90` are blocked; scores from `0.82` through `0.90` are retained for manual review. These initial similarity thresholds should be calibrated against real Prep AI examples before enabling broader automation.

PDF exports use Groq's `openai/gpt-oss-120b` model first and then switch permanently to `openai/gpt-oss-20b` when the 120B model reaches its quota or rate limit. Each PDF model is limited to 25 requests per rolling minute. Override them with `GROQ_PDF_MODEL_PRIMARY` and `GROQ_PDF_MODEL_SECONDARY` if needed.

Open http://localhost:3000.

## Deploy
This project is configured for static export, but AI generation needs a server/runtime. Deploy the same repository to Vercel/Netlify (or change `output: "export"` when using another server deployment). GitHub Pages alone cannot execute the `/api/answer` route.

## PDF export
The Export company PDF button generates and downloads a PDF directly. Cached answers are reused, and uncached requests are rate-limited across the two configured Groq PDF models.
