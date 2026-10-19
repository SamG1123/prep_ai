import seedQuestions from "../public/questions.json";
import { getQuestions, type QuestionDocument } from "./mongodb";
import { hashQuestion, normalizeQuestion, questionTokens } from "./question-utils";

let seedPromise: Promise<void> | undefined;

function toQuestionDocument(question: {
  sl_no: number | string;
  question: string;
  company?: string;
  role?: string;
  domains?: string[];
}): QuestionDocument {
  const normalized = normalizeQuestion(question.question);
  return {
    _id: `seed-${String(question.sl_no)}`,
    sl_no: question.sl_no,
    question: question.question.trim(),
    company: String(question.company || "").trim(),
    role: String(question.role || "").trim(),
    domains: Array.isArray(question.domains) ? question.domains.filter(Boolean) : [],
    questionNormalized: normalized,
    questionHash: hashQuestion(question.question),
    searchTokens: questionTokens(question.question),
    source: "seed",
  };
}

export async function ensureSeedQuestions() {
  if (seedPromise) return seedPromise;
  seedPromise = (async () => {
    const collection = await getQuestions();
    const operations = (seedQuestions as typeof seedQuestions).map((question) => {
      const document = toQuestionDocument(question);
      return {
        updateOne: {
          filter: { questionHash: document.questionHash },
          update: { $setOnInsert: document },
          upsert: true,
        },
      };
    });
    for (let index = 0; index < operations.length; index += 500) {
      await collection.bulkWrite(operations.slice(index, index + 500), { ordered: false });
    }
  })().catch((error) => {
    seedPromise = undefined;
    throw error;
  });
  return seedPromise;
}

export function toPublicQuestion(question: QuestionDocument) {
  return {
    sl_no: question.sl_no,
    question: question.question,
    company: question.company,
    role: question.role,
    domains: question.domains || [],
    tags: question.tags || [],
    difficulty: question.difficulty || "",
  };
}
