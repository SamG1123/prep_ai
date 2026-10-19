import { NextResponse } from "next/server";
import seedQuestions from "../../../public/questions.json";
import { ensureSeedQuestions, toPublicQuestion } from "../../../lib/question-store";
import { getQuestions } from "../../../lib/mongodb";

export async function GET() {
  try {
    await ensureSeedQuestions();
    const questions = await (await getQuestions())
      .find({}, { projection: { _id: 0, questionNormalized: 0, questionHash: 0, searchTokens: 0, embedding: 0 } })
      .sort({ sl_no: 1 })
      .toArray();
    return NextResponse.json({ questions: questions.map(toPublicQuestion) });
  } catch (error) {
    console.error("Unable to load questions from MongoDB; serving bundled question bank.", error);
    return NextResponse.json({
      questions: seedQuestions.map((question) => ({
        sl_no: question.sl_no,
        question: question.question,
        company: question.company || "",
        role: question.role || "",
        domains: question.domains || [],
        tags: [],
        difficulty: "",
      })),
      persistence: "unavailable",
    });
  }
}
