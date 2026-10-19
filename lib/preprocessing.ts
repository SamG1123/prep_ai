type PreprocessInput = {
  originalText: string;
  company: string;
  role: string;
  domain?: string;
  tags?: string[];
};

export type PreprocessedQuestion = {
  originalText: string;
  question: string;
  company: string;
  role: string;
  domain: string;
  tags: string[];
  difficulty: string;
  preprocessingStatus: "successful" | "needs_review" | "failed";
};

function parseJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The preprocessing model did not return JSON.");
  return JSON.parse(fenced.slice(start, end + 1));
}

function validateOutput(value: unknown, input: PreprocessInput): PreprocessedQuestion {
  if (!value || typeof value !== "object") throw new Error("Invalid preprocessing response.");
  const output = value as Record<string, unknown>;
  const question = typeof output.question === "string" ? output.question.trim() : "";
  const domain = typeof output.domain === "string" ? output.domain.trim() : "";
  const tags = Array.isArray(output.tags)
    ? output.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 12)
    : [];
  const difficulty = typeof output.difficulty === "string" ? output.difficulty.trim() : "";
  const status =
    output.preprocessingStatus === "needs_review" || !domain || !tags.length
      ? "needs_review"
      : "successful";
  if (!question || question.length > 500 || !input.company) {
    throw new Error("Preprocessing returned an incomplete question.");
  }
  return {
    originalText: input.originalText,
    question,
    company: input.company,
    role: input.role,
    domain,
    tags: input.tags?.length ? input.tags : tags,
    difficulty,
    preprocessingStatus: status,
  };
}

async function requestJson(system: string, user: string) {
  const failures: string[] = [];
  if (process.env.GROQ_API_KEY) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          temperature: 0,
          max_tokens: 600,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `Groq failed (${response.status}).`);
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (text) return parseJson(text);
      failures.push("Groq returned an empty response.");
    } catch (error) {
      failures.push(`Groq: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: "application/json" },
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || `Gemini failed (${response.status}).`);
      const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
      if (text) return parseJson(text);
      failures.push("Gemini returned an empty response.");
    } catch (error) {
      failures.push(`Gemini: ${error instanceof Error ? error.message : "request failed"}`);
    }
  }
  throw new Error(failures.join(" | ") || "Add GROQ_API_KEY or GEMINI_API_KEY to preprocess contributions.");
}

export async function preprocessQuestion(input: PreprocessInput) {
  const system = `You normalize interview questions into strict JSON. Return only an object with exactly these fields:
{"question":"string","domain":"string","tags":["string"],"difficulty":"easy|medium|hard|","preprocessingStatus":"successful|needs_review"}
  Preserve meaning, fix grammar, and do not invent company, role, requirements, or facts. Company and role are metadata supplied by the user; never change them.
  The supplied domain and tags are optional hints. When either is missing or empty, infer an appropriate domain and relevant topic tags from the question. Do not leave domain or tags empty unless the question is genuinely ambiguous.
  If the question is genuinely ambiguous, set preprocessingStatus to "needs_review", preserve the safest faithful normalization, and provide your best metadata suggestions when possible.`;
  const user = JSON.stringify({
    originalText: input.originalText,
    company: input.company,
    role: input.role,
    suppliedDomain: input.domain || "",
    suppliedTags: input.tags || [],
  });
  return validateOutput(await requestJson(system, user), input);
}

export async function createEmbedding(text: string) {
  if (!process.env.GEMINI_API_KEY) return null;
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `Gemini embeddings failed (${response.status}).`);
  const values = data?.embedding?.values;
  return Array.isArray(values) && values.every((value: unknown) => typeof value === "number") ? values : null;
}
