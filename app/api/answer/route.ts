import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type Style = "interviewee" | "normal" | "structured";

const prompts: Record<Style,string> = {
  interviewee: `Answer as a strong college interview candidate speaking naturally. Use first person where appropriate, sound confident but not scripted, and keep the answer concise enough to say aloud.`,
  normal: `Give a clear explanatory answer suitable for study notes. Define terms, explain why they matter, and add a short example when useful.`,
  structured: `Use this exact structure when it fits: Answer -> Key Points -> Example -> Interview Tip. Keep technical answers precise and practical.`
};

export async function POST(req:NextRequest){
  try {
    if(!process.env.ANTHROPIC_API_KEY) return NextResponse.json({error:"ANTHROPIC_API_KEY is not configured on the server."},{status:500});
    const body = await req.json();
    const question = String(body.question ?? "").trim();
    const style = (body.style ?? "interviewee") as Style;
    const company = String(body.company ?? "").trim();
    const role = String(body.role ?? "").trim();
    const domain = String(body.domain ?? "").trim();
    if(!question) return NextResponse.json({error:"Question is required."},{status:400});
    const system = `You are an interview preparation assistant. Company: ${company}. Role: ${role}. Domain: ${domain}. ${prompts[style] || prompts.interviewee}
Do not invent personal experience for the candidate. For behavioral questions, provide a polished adaptable answer that the candidate can personalize.`;
    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1400,
      system,
      messages: [{role:"user", content: question}]
    });
    const text = response.content.filter((b)=>b.type==="text").map((b:any)=>b.text).join("\n");
    return NextResponse.json({answer:text});
  } catch (e:any) {
    return NextResponse.json({error:e?.message ?? "Generation failed."},{status:500});
  }
}
