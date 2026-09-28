import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";

type Style = "interviewee" | "normal" | "structured";

const prompts: Record<Style,string> = {
  interviewee: `Answer as a strong college interview candidate speaking naturally. Use first person where appropriate, sound confident but not scripted, and keep the answer concise enough to say aloud.`,
  normal: `Give a clear explanatory answer suitable for study notes. Define terms, explain why they matter, and add a short example when useful.`,
  structured: `Use this exact structure when it fits: Answer -> Key Points -> Example -> Interview Tip. Keep technical answers precise and practical.`
};

type Provider = { name: string; request: () => Promise<string> };

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

function getAnswerCacheKey(input: object) {
  const hash = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return `prep-ai:answer:v1:${hash}`;
}

async function redisCommand(command: string[]) {
  const config = getRedisConfig();
  if(!config) return null;
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000),
  });
  if(!response.ok) throw new Error(`Redis request failed (${response.status}).`);
  const data = await response.json();
  return data.result ?? null;
}

async function readResponse(response: Response, provider: string) {
  const data = await response.json();
  if(!response.ok) throw new Error(data?.error?.message || `${provider} request failed (${response.status}).`);
  return data;
}

export async function POST(req:NextRequest){
  try {
    const body = await req.json();
    const question = String(body.question ?? "").trim();
    const style = (body.style ?? "interviewee") as Style;
    const company = String(body.company ?? "").trim();
    const role = String(body.role ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    const isPdfRequest = body.pdf === true;
    const requestedPdfModel = String(body.pdfModel ?? "").trim();
    if(!question) return NextResponse.json({error:"Question is required."},{status:400});
    const cacheKey = getAnswerCacheKey({ question, company, role, domain, style });
    let redisEnabled = Boolean(getRedisConfig());
    if(redisEnabled){
      try {
        const cachedAnswer = await redisCommand(["GET", cacheKey]);
        if(typeof cachedAnswer === "string" && cachedAnswer.trim()){
          return NextResponse.json({answer:cachedAnswer, provider:"Redis", cached:true});
        }
      } catch {
        redisEnabled = false;
      }
    }
    const system = `You are an interview preparation assistant. Company: ${company}. Role: ${role}. Domain: ${domain}. ${prompts[style] || prompts.interviewee}
Do not invent personal experience for the candidate. For behavioral questions, provide a polished adaptable answer that the candidate can personalize.`;
    const providers: Provider[] = [];
    const pdfPrimaryModel = process.env.GROQ_PDF_MODEL_PRIMARY || "openai/gpt-oss-120b";
    const pdfSecondaryModel = process.env.GROQ_PDF_MODEL_SECONDARY || "openai/gpt-oss-20b";
    const groqModel = isPdfRequest
      ? [pdfPrimaryModel, pdfSecondaryModel].includes(requestedPdfModel)
        ? requestedPdfModel
        : pdfPrimaryModel
      : process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
    if(process.env.GROQ_API_KEY) providers.push({
      name: `Groq (${groqModel})`,
      request: async () => {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: groqModel,
            messages: [{ role: "system", content: system }, { role: "user", content: question }],
            max_tokens: 1400,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await readResponse(response, "Groq");
        return data?.choices?.[0]?.message?.content?.trim() || "";
      },
    });
    if(!isPdfRequest && process.env.GEMINI_API_KEY) providers.push({
      name: "Gemini",
      request: async () => {
        const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: question }] }],
            generationConfig: { maxOutputTokens: 1400 },
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await readResponse(response, "Gemini");
        return data?.candidates?.[0]?.content?.parts?.map((part:{text?:string})=>part.text || "").join("\n").trim() || "";
      },
    });
    if(!providers.length) return NextResponse.json({error:isPdfRequest ? "GROQ_API_KEY is required for PDF generation." : "Add GROQ_API_KEY or GEMINI_API_KEY to the server environment."},{status:500});
    const failures: string[] = [];
    for(const provider of providers){
      try {
        const text = await provider.request();
        if(text){
          if(redisEnabled){
            try {
              await redisCommand(["SET", cacheKey, text, "EX", String(CACHE_TTL_SECONDS)]);
            } catch {
              // Redis is an optimization; provider responses must still succeed if it is unavailable.
            }
          }
          return NextResponse.json({answer:text, provider:provider.name, cached:false});
        }
        failures.push(`${provider.name} returned an empty answer`);
      } catch(error: any) {
        failures.push(`${provider.name}: ${error?.message || "request failed"}`);
      }
    }
    const error = new Error(`All configured AI providers failed. ${failures.join(" | ")}`);
    (error as Error & { status?: number }).status = failures.some((failure) => /429|rate|quota|limit|capacity/i.test(failure)) ? 429 : 500;
    throw error;
  } catch (e:any) {
    return NextResponse.json({error:e?.message ?? "Generation failed."},{status:e?.status ?? 500});
  }
}
