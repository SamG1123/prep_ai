# Interview Prep AI

A full-stack Next.js interview-preparation app built around the supplied company-wise interview-question workbook.

## Included
- Company filter with 130 unique company labels from the workbook
- Domain filter
- Full-text question search
- AI answer studio with three styles: Interviewee, Normal, Specific format
- Company-level printable PDF export
- 7,475 deduplicated question records bundled as JSON
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

PDF exports use Groq's `openai/gpt-oss-120b` model first and then switch permanently to `openai/gpt-oss-20b` when the 120B model reaches its quota or rate limit. Each PDF model is limited to 25 requests per rolling minute. Override them with `GROQ_PDF_MODEL_PRIMARY` and `GROQ_PDF_MODEL_SECONDARY` if needed.

Open http://localhost:3000.

## Deploy
This project is configured for static export, but AI generation needs a server/runtime. Deploy the same repository to Vercel/Netlify (or change `output: "export"` when using another server deployment). GitHub Pages alone cannot execute the `/api/answer` route.

## PDF export
The Export company PDF button generates and downloads a PDF directly. Cached answers are reused, and uncached requests are rate-limited across the two configured Groq PDF models.
