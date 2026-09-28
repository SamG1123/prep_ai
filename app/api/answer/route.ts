import { NextRequest, NextResponse } from "next/server";

type Style = "interviewee" | "normal" | "structured";

const prompts: Record<Style,string> = {
  interviewee: `Answer as a strong college interview candidate speaking naturally. Use first person where appropriate, sound confident but not scripted, and keep the answer concise enough to say aloud.`,
  normal: `Give a clear explanatory answer suitable for study notes. Define terms, explain why they matter, and add a short example when useful.`,
  structured: `Use this exact structure when it fits: Answer -> Key Points -> Example -> Interview Tip. Keep technical answers precise and practical.`
};

export async function POST(req:NextRequest){
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if(!apiKey) return NextResponse.json({error:"GEMINI_API_KEY is not configured on the server."},{status:500});
    const body = await req.json();
    const question = String(body.question ?? "").trim();
    const style = (body.style ?? "interviewee") as Style;
    const company = String(body.company ?? "").trim();
    const role = String(body.role ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    if(!question) return NextResponse.json({error:"Question is required."},{status:400});
    const system = `You are an interview preparation assistant. Company: ${company}. Role: ${role}. Domain: ${domain}. ${prompts[style] || prompts.interviewee}
Do not invent personal experience for the candidate. For behavioral questions, provide a polished adaptable answer that the candidate can personalize.`;
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { maxOutputTokens: 1400 },
      }),
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data?.error?.message || "Gemini request failed.");
    const text = data?.candidates?.[0]?.content?.parts?.map((part:{text?:string})=>part.text || "").join("\n").trim();
    if(!text) throw new Error("Gemini returned an empty answer.");
    return NextResponse.json({answer:text});
  } catch (e:any) {
    return NextResponse.json({error:e?.message ?? "Generation failed."},{status:500});
  }
}
