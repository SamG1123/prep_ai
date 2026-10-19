import { createHash } from "node:crypto";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "can", "do", "for", "how", "in", "is",
  "it", "of", "on", "or", "the", "to", "what", "when", "why", "with",
]);

export function normalizeQuestion(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashQuestion(value: string) {
  return createHash("sha256").update(normalizeQuestion(value)).digest("hex");
}

export function questionTokens(value: string) {
  return normalizeQuestion(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const a = left[index] || 0;
    const b = right[index] || 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function tokenSimilarity(left: string[], right: string[]) {
  const vocabulary = Array.from(new Set([...left, ...right]));
  const leftVector = vocabulary.map((token) => left.filter((item) => item === token).length);
  const rightVector = vocabulary.map((token) => right.filter((item) => item === token).length);
  return cosineSimilarity(leftVector, rightVector);
}
