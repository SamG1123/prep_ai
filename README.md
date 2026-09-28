# Interview Prep AI

A full-stack Next.js interview-preparation app built around the supplied company-wise interview-question workbook.

## Included
- Company filter with 130 unique company labels from the workbook
- Domain filter
- Full-text question search
- AI answer studio with three styles: Interviewee, Normal, Specific format
- Company-level printable PDF export
- 7,475 deduplicated question records bundled as JSON
- API route for server-side Anthropic calls, keeping the API key out of the browser

## Run locally
```bash
npm install
cp .env.example .env.local
# add ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000.

## Deploy
This project is configured for static export, but AI generation needs a server/runtime. Deploy the same repository to Vercel/Netlify (or change `output: "export"` when using another server deployment). GitHub Pages alone cannot execute the `/api/answer` route.

## PDF export
The Export company PDF button opens a print-ready formatted document and invokes the browser print dialog. Choose “Save as PDF”.
