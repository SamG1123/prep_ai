import { NextResponse } from "next/server";
import { ensureSeedQuestions } from "../../../lib/question-store";
import { getQuestions } from "../../../lib/mongodb";
import { toPublicQuestion } from "../../../lib/question-store";

export async function GET() {
  try {
    await ensureSeedQuestions();
    const questions = await (await getQuestions())
      .find({}, { projection: { _id: 0, questionNormalized: 0, questionHash: 0, searchTokens: 0, embedding: 0 } })
      .sort({ sl_no: 1 })
      .toArray();
    return NextResponse.json({ questions: questions.map(toPublicQuestion) });
  } catch (error) {
    console.error("Unable to load questions.", error);
    return NextResponse.json({ error: "The question bank is temporarily unavailable." }, { status: 503 });
  }
}
