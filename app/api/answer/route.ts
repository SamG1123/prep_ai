import { NextRequest, NextResponse } from "next/server";

type Style = "interviewee" | "normal" | "structured";

const prompts: Record<Style,string> = {
  interviewee: `Answer as a strong college interview candidate speaking naturally. Use first person where appropriate, sound confident but not scripted, and keep the answer concise enough to say aloud.`,
  normal: `Give a clear explanatory answer suitable for study notes. Define terms, explain why they matter, and add a short example when useful.`,
  structured: `Use this exact structure when it fits: Answer -> Key Points -> Example -> Interview Tip. Keep technical answers precise and practical.`
};

type Provider = { name: string; request: () => Promise<string> };

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
    if(!question) return NextResponse.json({error:"Question is required."},{status:400});
    const system = `You are an interview preparation assistant. Company: ${company}. Role: ${role}. Domain: ${domain}. ${prompts[style] || prompts.interviewee}
Do not invent personal experience for the candidate. For behavioral questions, provide a polished adaptable answer that the candidate can personalize.`;
    const providers: Provider[] = [];
    if(process.env.GROQ_API_KEY) providers.push({
      name: "Groq",
      request: async () => {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
            messages: [{ role: "system", content: system }, { role: "user", content: question }],
            max_tokens: 1400,
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await readResponse(response, "Groq");
        return data?.choices?.[0]?.message?.content?.trim() || "";
      },
    });
    if(process.env.GEMINI_API_KEY) providers.push({
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
    if(!providers.length) return NextResponse.json({error:"Add GROQ_API_KEY or GEMINI_API_KEY to the server environment."},{status:500});
    const failures: string[] = [];
    for(const provider of providers){
      try {
        const text = await provider.request();
        if(text) return NextResponse.json({answer:text, provider:provider.name});
        failures.push(`${provider.name} returned an empty answer`);
      } catch(error: any) {
        failures.push(`${provider.name}: ${error?.message || "request failed"}`);
      }
    }
    throw new Error(`All configured AI providers failed. ${failures.join(" | ")}`);
  } catch (e:any) {
    return NextResponse.json({error:e?.message ?? "Generation failed."},{status:500});
  }
}
