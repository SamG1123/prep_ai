"use client";

import { useEffect, useMemo, useState } from "react";
import { signIn, signOut, useSession } from "next-auth/react";
import { AnimatePresence, motion } from "framer-motion";
import * as XLSX from "xlsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  Document,
  Page,
  StyleSheet,
  Text,
  View,
  pdf,
} from "@react-pdf/renderer";
import {
  Check,
  Clipboard,
  Download,
  FileUp,
  LockKeyhole,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  Network,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRound,
  Volume2,
} from "lucide-react";

type Q = {
  sl_no: number | string;
  question: string;
  company: string;
  role: string;
  domains: string[];
};
type Style = "interviewee" | "normal" | "structured";
type AnswerCache = Record<string, string>;
type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatHistoryItem = {
  id: string;
  title: string;
  context: string;
  updatedAt: string;
};
type ReviewBatch = {
  _id: string;
  status: string;
  company: string;
  items: Array<{
    originalText: string;
    question: string;
    company: string;
    role: string;
    domain: string;
    tags: string[];
    difficulty?: string;
    exactDuplicate: boolean;
    similarityScore: number;
    preprocessingStatus: string;
    reviewStatus?: "pending" | "approved" | "rejected";
    reviewNote?: string;
    nearestMatch?: { question: string; company: string; score: number };
  }>;
};

const ANSWER_CACHE_KEY = "prep-ai-answer-cache-v1";
const PDF_REQUEST_LIMIT = 20;
const PDF_REQUEST_WINDOW_MS = 60_000;
const PDF_PRIMARY_MODEL = "openai/gpt-oss-120b";
const PDF_SECONDARY_MODEL = "openai/gpt-oss-20b";
const pdfRequestTimes = new Map<string, number[]>();
const normalize = (value: string) => value.trim().toLowerCase();
const unique = (values: string[]) =>
  Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
const domainAliases: Record<string, string[]> = {
  "Data Structures & Algorithms": ["coding", "programming", "algorithms", "dsa"],
  "Object-Oriented Programming": [
    "coding",
    "programming",
    "oop",
    "object oriented",
    "object-oriented",
  ],
  "Programming Languages": [
    "coding",
    "programming",
    "language",
    "languages",
    "c",
    "c++",
    "c#",
    "go",
    "java",
    "javascript",
    "kotlin",
    "php",
    "python",
    "ruby",
    "rust",
    "swift",
    "typescript",
  ],
  "Software Development": ["coding", "programming", "software", "development"],
  "Software Engineering": ["coding", "programming", "software", "engineering"],
  "Web Development": [
    "coding",
    "programming",
    "web",
    "frontend",
    "front-end",
    "backend",
    "back-end",
    "html",
    "css",
    "javascript",
    "typescript",
  ],
};

function getDomainSearchText(domain: string) {
  return [domain, ...(domainAliases[domain] || [])].map(normalize).join(" ");
}

function SearchableFilter({
  value,
  options,
  allLabel,
  placeholder,
  searchText,
  onChange,
}: {
  value: string;
  options: string[];
  allLabel: string;
  placeholder: string;
  searchText?: (option: string) => string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedLabel = value || allLabel;
  const visibleOptions = useMemo(() => {
    const term = normalize(query);
    return [allLabel, ...options].filter(
      (option) =>
        !term || (searchText ? searchText(option) : normalize(option)).includes(term),
    );
  }, [allLabel, options, query, searchText]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return (
    <div className="searchable-filter">
      <Search size={13} />
      <input
        value={open ? query : selectedLabel}
        onFocus={() => {
          setQuery(value);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 140)}
        placeholder={placeholder}
        aria-label={placeholder}
      />
      {open && (
        <div className="searchable-options">
          {visibleOptions.length > 0 ? (
            visibleOptions.map((option) => (
              <button
                type="button"
                key={option}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option === allLabel ? "" : option);
                  setQuery("");
                  setOpen(false);
                }}
                className={option === selectedLabel ? "selected" : ""}
              >
                {option}
              </button>
            ))
          ) : (
            <span className="searchable-empty">No matches found</span>
          )}
        </div>
      )}
    </div>
  );
}

function getAnswerCacheKey(question: Q, style: Style) {
  return JSON.stringify([
    String(question.sl_no),
    question.question,
    question.company,
    question.role,
    question.domains.join(", "),
    style,
  ]);
}

function readAnswerCache(): AnswerCache {
  if (typeof window === "undefined") return {};
  try {
    const saved = window.localStorage.getItem(ANSWER_CACHE_KEY);
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hasPdfRequestSlot(model: string) {
  const requestTimes = pdfRequestTimes.get(model) || [];
  const now = Date.now();
  while (
    requestTimes.length > 0 &&
    now - requestTimes[0] >= PDF_REQUEST_WINDOW_MS
  ) {
    requestTimes.shift();
  }
  pdfRequestTimes.set(model, requestTimes);
  return requestTimes.length < PDF_REQUEST_LIMIT;
}

function choosePdfModel(activeModel: string) {
  if (activeModel === PDF_PRIMARY_MODEL && hasPdfRequestSlot(PDF_PRIMARY_MODEL)) {
    return PDF_PRIMARY_MODEL;
  }
  return PDF_SECONDARY_MODEL;
}

async function waitForPdfRequestSlot(model: string) {
  while (true) {
    const requestTimes = pdfRequestTimes.get(model) || [];
    const now = Date.now();
    while (
      requestTimes.length > 0 &&
      now - requestTimes[0] >= PDF_REQUEST_WINDOW_MS
    ) {
      requestTimes.shift();
    }

    if (requestTimes.length < PDF_REQUEST_LIMIT) {
      requestTimes.push(now);
      pdfRequestTimes.set(model, requestTimes);
      return;
    }

    const waitTime = PDF_REQUEST_WINDOW_MS - (now - requestTimes[0]) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
  }
}

function normalizeMathDelimiters(markdown: string) {
  const normalized = markdown
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => `\n$$\n${expression}\n$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, expression: string) => `$${expression}$`);

  return normalized
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("[") &&
        trimmed.endsWith("]") &&
        /\\[a-zA-Z]+|[=^_]/.test(trimmed)
      ) {
        return `$$\n${trimmed.slice(1, -1).trim()}\n$$`;
      }
      return line;
    })
    .join("\n");
}

const pdfStyles = StyleSheet.create({
  page: { padding: 42, color: "#1a1b1f", fontFamily: "Helvetica" },
  title: { fontSize: 22, marginBottom: 6 },
  subtitle: { fontSize: 10, color: "#60636e", marginBottom: 22 },
  question: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 5 },
  meta: { fontSize: 9, color: "#60636e", marginBottom: 8 },
  answer: { fontSize: 10, lineHeight: 1.45 },
  item: { marginBottom: 18, paddingBottom: 12, borderBottom: "1 solid #e3e2e7" },
});

function AnswerPackDocument({
  company,
  style,
  questions,
  answers,
}: {
  company: string;
  style: Style;
  questions: Q[];
  answers: Record<string, string>;
}) {
  return (
    <Document title={`${company} Interview Answers`}>
      <Page size="A4" style={pdfStyles.page} wrap>
        <Text style={pdfStyles.title}>{company} - Interview Answer Pack</Text>
        <Text style={pdfStyles.subtitle}>
          {questions.length} questions - Style: {style}
        </Text>
        {questions.map((question, index) => (
          <View style={pdfStyles.item} key={String(question.sl_no)} wrap>
            <Text style={pdfStyles.question}>
              Q{index + 1}. {question.question}
            </Text>
            <Text style={pdfStyles.meta}>
              {question.domains.join(", ")}
              {question.role ? ` · ${question.role}` : ""}
            </Text>
            <Text style={pdfStyles.answer}>
              {answers[String(question.sl_no)] || ""}
            </Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export default function InterviewStudio() {
  const { data: session, status: authStatus } = useSession();
  const [qs, setQs] = useState<Q[]>([]);
  const [questionBankError, setQuestionBankError] = useState("");
  const [contributeOpen, setContributeOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminData, setAdminData] = useState<{
    settings: { duplicateReviewThreshold: number; duplicateBlockThreshold: number; autoPublishLowRisk: boolean };
    stats: { pending: number; published: number; rejected: number; questionCount: number };
    audit: Array<{ _id?: string; action: string; company: string; reviewerEmail: string; createdAt: string }>;
  } | null>(null);
  const [adminSettings, setAdminSettings] = useState({ duplicateReviewThreshold: 0.82, duplicateBlockThreshold: 0.9, autoPublishLowRisk: false });
  const [adminSaving, setAdminSaving] = useState(false);
  const [contributionCompany, setContributionCompany] = useState("");
  const [contributionRole, setContributionRole] = useState("");
  const [contributionDomain, setContributionDomain] = useState("");
  const [contributionTags, setContributionTags] = useState("");
  const [contributionText, setContributionText] = useState("");
  const [contributionFile, setContributionFile] = useState("");
  const [contributionFileType, setContributionFileType] = useState<"text" | "csv" | "xlsx" | "txt">("text");
  const [contributionImportedItems, setContributionImportedItems] = useState<Array<{ text: string; domain: string; tags: string[] }>>([]);
  const [contributionLoading, setContributionLoading] = useState(false);
  const [contributionResult, setContributionResult] = useState<{ batchId: string; status: string; items: Array<{ question: string; similarityScore: number; exactDuplicate: boolean; nearestMatch?: { question: string; company: string; score: number } }> } | null>(null);
  const [reviewBatches, setReviewBatches] = useState<ReviewBatch[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewSaving, setReviewSaving] = useState("");
  const [selectedReviewBatch, setSelectedReviewBatch] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewBatch["items"][number]>>({});
  const companies = useMemo(
    () => unique(qs.map((question) => question.company)),
    [qs],
  );
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("All domains");
  const [search, setSearch] = useState("");
  const [style, setStyle] = useState<Style>("interviewee");
  const [selected, setSelected] = useState<Q | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answerCache, setAnswerCache] = useState<AnswerCache>(readAnswerCache);
  const [answerSource, setAnswerSource] = useState<"cache" | "redis" | "generated" | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatConversationId, setChatConversationId] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>([]);
  const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [authView, setAuthView] = useState<"signin" | "signup">("signin");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/questions")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load the question bank.");
        if (!cancelled) setQs(data.questions || []);
      })
      .catch((error) => {
        if (!cancelled) setQuestionBankError(error instanceof Error ? error.message : "Unable to load the question bank.");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!reviewOpen || authStatus !== "authenticated") return;
    setReviewLoading(true);
    fetch("/api/contributions?status=awaiting_review")
      .then(async (response) => {
        const data = await response.json();
        if (response.ok) setReviewBatches(data.batches || []);
      })
      .catch(() => undefined)
      .finally(() => setReviewLoading(false));
  }, [authStatus, reviewOpen]);
  useEffect(() => {
    if (authStatus !== "authenticated") {
      setIsAdmin(false);
      return;
    }
    fetch("/api/admin")
      .then(async (response) => {
        if (response.status === 403) return;
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load admin panel.");
        setIsAdmin(true);
        setAdminData(data);
        setAdminSettings(data.settings);
      })
      .catch(() => setIsAdmin(false));
  }, [authStatus]);
  const domains = useMemo(
    () => unique(qs.flatMap((question) => question.domains ?? [])),
    [qs],
  );
  const filtered = useMemo(() => {
    const term = normalize(search);
    return qs.filter(
      (question) =>
        (!company || question.company === company) &&
        (domain === "All domains" || (question.domains ?? []).includes(domain)) &&
        (!term ||
          normalize(question.question).includes(term) ||
          (question.domains ?? []).some((item) =>
            getDomainSearchText(item).includes(term),
          )),
    );
  }, [company, domain, qs, search]);

  useEffect(() => {
    if (authStatus !== "authenticated" || !chatOpen) return;
    let cancelled = false;
    setChatHistoryLoading(true);
    fetch("/api/chat")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load chat history.");
        if (!cancelled) setChatHistory(data.conversations || []);
      })
      .catch((error) => {
        if (!cancelled) console.error("Unable to load chat history.", error);
      })
      .finally(() => {
        if (!cancelled) setChatHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus, chatOpen]);

  async function generate(question: Q, responseStyle: Style = style) {
    if (!selected || String(selected.sl_no) !== String(question.sl_no)) {
      setChatMessages([]);
      setChatConversationId("");
      setChatOpen(false);
    }
    setSelected(question);
    const cacheKey = getAnswerCacheKey(question, responseStyle);
    const cachedAnswer = answerCache[cacheKey];
    if (cachedAnswer) {
      setAnswers((current) => ({
        ...current,
        [String(question.sl_no)]: cachedAnswer,
      }));
      setAnswerSource("cache");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: question.question,
          company: question.company,
          role: question.role,
          domain: question.domains.join(", "),
          style: responseStyle,
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Failed to generate an answer.");
      setAnswers((current) => ({
        ...current,
        [String(question.sl_no)]: data.answer,
      }));
      setAnswerCache((current) => {
        const next = { ...current, [cacheKey]: data.answer };
        try {
          window.localStorage.setItem(ANSWER_CACHE_KEY, JSON.stringify(next));
        } catch {
          // Storage can be unavailable in private browsing or restricted embeds.
        }
        return next;
      });
      setAnswerSource(data.cached && data.provider === "Redis" ? "redis" : "generated");
    } catch (error: any) {
      alert(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function copyAnswer() {
    if (!selected || !answers[String(selected.sl_no)]) return;
    await navigator.clipboard.writeText(answers[String(selected.sl_no)]);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  function readAnswerAloud() {
    if (!selected || !answers[String(selected.sl_no)] || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(
      new SpeechSynthesisUtterance(answers[String(selected.sl_no)]),
    );
  }

  function openChat() {
    setChatOpen(true);
  }

  function startNewChat() {
    setChatConversationId("");
    setChatMessages([]);
    setChatInput("");
    setChatOpen(true);
  }

  async function openPastChat(conversationId: string) {
    setChatLoading(true);
    try {
      const response = await fetch(`/api/chat?conversationId=${encodeURIComponent(conversationId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to open conversation.");
      setChatConversationId(data.conversation.id);
      setChatMessages(data.conversation.messages.map((message: ChatMessage) => ({
        role: message.role,
        content: message.content,
      })));
      const matchingQuestion = qs.find(
        (question) =>
          question.question === data.conversation.question.text &&
          question.company === data.conversation.question.company,
      );
      if (matchingQuestion) {
        setSelected(matchingQuestion);
        if (data.conversation.question.generatedAnswer) {
          setAnswers((current) => ({
            ...current,
            [String(matchingQuestion.sl_no)]: data.conversation.question.generatedAnswer,
          }));
        }
      }
      setChatOpen(true);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setChatLoading(false);
    }
  }

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      if (authView === "signup") {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: authName, email: authEmail, password: authPassword }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to create account.");
      }
      const result = await signIn("credentials", {
        email: authEmail,
        password: authPassword,
        redirect: false,
      });
      if (result?.error) throw new Error("Email or password is incorrect.");
      setAuthOpen(false);
      setAuthPassword("");
      window.location.reload();
    } catch (error: any) {
      setAuthError(error.message);
    } finally {
      setAuthLoading(false);
    }
  }

  async function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chatInput.trim() || chatLoading) return;
    const message = chatInput.trim();
    const conversationId = chatConversationId || window.crypto.randomUUID();
    setChatConversationId(conversationId);
    setChatInput("");
    setChatMessages((current) => [...current, { role: "user", content: message }]);
    setChatLoading(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message,
          question: selected?.question || "",
          company: selected?.company || "",
          role: selected?.role || "",
          domain: selected?.domains?.join(", ") || "",
          generatedAnswer: selected ? answers[String(selected.sl_no)] || "" : "",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chat request failed.");
      setChatMessages((current) => [
        ...current,
        { role: "assistant", content: data.message },
      ]);
      if (authStatus === "authenticated") {
        try {
          const historyResponse = await fetch("/api/chat");
          const historyData = await historyResponse.json();
          if (historyResponse.ok) setChatHistory(historyData.conversations || []);
        } catch (error) {
          console.error("Unable to refresh chat history.", error);
        }
      }
    } catch (error: any) {
      setChatMessages((current) => current.slice(0, -1));
      alert(error.message);
    } finally {
      setChatLoading(false);
    }
  }

  async function exportPDF() {
    if (!company) {
      alert("Select a company first.");
      return;
    }
    const companyQuestions = qs.filter(
      (question) => question.company === company,
    );
    setExporting(true);
    try {
      let activePdfModel = PDF_PRIMARY_MODEL;
      const newAnswers: Record<string, string> = {};
      for (const question of companyQuestions) {
        const cacheKey = getAnswerCacheKey(question, style);
        const cachedAnswer = answerCache[cacheKey];
        if (cachedAnswer) {
          newAnswers[String(question.sl_no)] = cachedAnswer;
          continue;
        }
        activePdfModel = choosePdfModel(activePdfModel);
        await waitForPdfRequestSlot(activePdfModel);
        let response = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: question.question,
            company: question.company,
            role: question.role,
            domain: question.domains.join(", "),
            style,
            pdf: true,
            pdfModel: activePdfModel,
          }),
        });
        let data = await response.json();
        if (!response.ok && activePdfModel === PDF_PRIMARY_MODEL) {
          activePdfModel = PDF_SECONDARY_MODEL;
          await waitForPdfRequestSlot(activePdfModel);
          response = await fetch("/api/answer", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              question: question.question,
              company: question.company,
              role: question.role,
              domain: question.domains.join(", "),
              style,
              pdf: true,
              pdfModel: activePdfModel,
            }),
          });
          data = await response.json();
        }
        if (!response.ok)
          throw new Error(data.error || "Failed to generate an answer.");
        newAnswers[String(question.sl_no)] = data.answer;
        setAnswerCache((current) => {
          const next = { ...current, [cacheKey]: data.answer };
          try {
            window.localStorage.setItem(ANSWER_CACHE_KEY, JSON.stringify(next));
          } catch {
            // Storage can be unavailable in private browsing or restricted embeds.
          }
          return next;
        });
      }
      setAnswers(newAnswers);
      const blob = await pdf(
        <AnswerPackDocument
          company={company}
          style={style}
          questions={companyQuestions}
          answers={newAnswers}
        />,
      ).toBlob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${company.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}-interview-answers.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(error.message);
    } finally {
      setExporting(false);
    }
  }

  async function readContributionFile(file: File) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".txt")) {
      setContributionFileType("txt");
      setContributionImportedItems([]);
      setContributionText(await file.text());
      return;
    }
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(firstSheet, { header: 1, defval: "" })
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => row.map((cell) => String(cell).trim()));
    const header = rows[0]?.map((cell) => cell.toLowerCase()) || [];
    const questionIndex = header.findIndex((cell) => /question|text|prompt/.test(cell));
    const domainIndex = header.findIndex((cell) => cell === "domain" || cell === "category");
    const tagsIndex = header.findIndex((cell) => /tags?|topics?/.test(cell));
    const dataRows = questionIndex >= 0 ? rows.slice(1) : rows;
    const importedItems = dataRows
      .map((row) => ({
        text: row[questionIndex >= 0 ? questionIndex : 0] || "",
        domain: domainIndex >= 0 ? row[domainIndex] || "" : "",
        tags: tagsIndex >= 0 ? (row[tagsIndex] || "").split(",").map((tag) => tag.trim()).filter(Boolean) : [],
      }))
      .filter((item) => item.text);
    const lines = importedItems.map((item) => item.text);
    setContributionImportedItems(importedItems);
    setContributionFileType(lowerName.endsWith(".xlsx") ? "xlsx" : "csv");
    setContributionText(lines.join("\n"));
  }

  async function submitContribution() {
    if (!contributionCompany.trim() || !contributionText.trim()) {
      alert("Add a company name and at least one question.");
      return;
    }

    const questions = (contributionImportedItems.length ? contributionImportedItems : contributionText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({
        text: line,
        domain: contributionDomain.trim(),
        tags: contributionTags.split(",").map((tag) => tag.trim()).filter(Boolean),
      })));
    setContributionLoading(true);
    setContributionResult(null);
    try {
      const response = await fetch("/api/contributions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: contributionCompany.trim(),
          role: contributionRole.trim(),
          questions,
          sourceType: contributionFileType,
          fileName: contributionFile,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to submit contribution.");
      setContributionResult(data);
      setContributionText("");
      setContributionFile("");
      setContributionImportedItems([]);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Unable to submit contribution.");
    } finally {
      setContributionLoading(false);
    }
  }

  async function reviewBatch(
    batchId: string,
    action: "publish" | "reject" | "edit" | "approve" | "reject_item",
    indexes?: number[],
    index?: number,
    draft?: ReviewBatch["items"][number],
  ) {
    const key = `${batchId}:${index ?? action}`;
    setReviewSaving(key);
    const response = await fetch(`/api/contributions/${batchId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        indexes,
        index,
        ...(index !== undefined && action === "edit"
          ? draft || reviewDrafts[`${batchId}:${index}`]
          : {}),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      alert(data.error || "Unable to update contribution.");
      setReviewSaving("");
      return;
    }

    if (action === "publish" || action === "reject") {
      setReviewBatches((current) => current.filter((batch) => batch._id !== batchId));
    } else {
      setReviewBatches((current) => current.map((batch) => {
        if (batch._id !== batchId || index === undefined || !data.item) return batch;
        return {
          ...batch,
          items: data.deleted
            ? batch.items.filter((_item, itemIndex) => itemIndex !== index)
            : batch.items.map((item, itemIndex) => itemIndex === index ? data.item : item),
        };
      }).filter((batch) => batch.items.length > 0));
    }
    setReviewSaving("");
  }

  async function saveAdminSettings() {
    setAdminSaving(true);
    try {
      const response = await fetch("/api/admin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(adminSettings),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to save admin settings.");
      setAdminData((current) => current ? { ...current, settings: data.settings } : current);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Unable to save admin settings.");
    } finally {
      setAdminSaving(false);
    }
  }

  return (
    <main className={`studio-shell ${reviewOpen ? "management-shell" : ""}`}>
      <header className="studio-header">
        <div className="brand-lockup">
          <div className="brand-mark">
            <Sparkles size={17} />
          </div>
          <div>
            <div className="brand-name">PREP AI</div>
            <div className="brand-subtitle">Interview answer studio</div>
          </div>
        </div>
        <div className="breadcrumb">
          <span className="breadcrumb-company">
            {company || "All companies"}
          </span>
          <span>/</span>
          <span>{domain === "All domains" ? "Question bank" : domain}</span>
          <span>/</span>
          <strong>Track {selected ? `#${selected.sl_no}` : "ready"}</strong>
        </div>
        <div className="header-actions">
          <button
            className="export-button"
            onClick={exportPDF}
            disabled={exporting || !company}
          >
            {exporting ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Download size={16} />
            )}{" "}
            Export pack
          </button>
          {authStatus === "authenticated" ? (
            <button className="auth-button" onClick={() => void signOut()}>
              <UserRound size={15} />
              <span>{session.user?.name || session.user?.email || "Account"}</span>
              <span className="auth-action-label">Sign out</span>
            </button>
          ) : (
            <button className="auth-button" onClick={() => setAuthOpen(true)}>
              <UserRound size={15} />
              Sign in
            </button>
          )}
        </div>
      </header>

      <div className="studio-layout">
        <aside className="navigator-rail">
          <div className="sidebar-nav" aria-label="Primary navigation">
            <span className="sidebar-nav-label">WORKSPACE</span>
            <button className={`sidebar-nav-item ${!contributeOpen && !reviewOpen && !adminOpen ? "active" : ""}`} onClick={() => { setChatOpen(false); setContributeOpen(false); setReviewOpen(false); setAdminOpen(false); }}>
              <Network size={15} />
              <span>Question bank</span>
            </button>
            <button className={`sidebar-nav-item ${contributeOpen ? "active" : ""}`} onClick={() => { setChatOpen(false); setContributeOpen(true); setReviewOpen(false); setAdminOpen(false); }}>
              <FileUp size={15} />
              <span>Contribute questions</span>
            </button>
            {authStatus === "authenticated" && (
              <button className={`sidebar-nav-item ${reviewOpen ? "active" : ""}`} onClick={() => { setChatOpen(false); setContributeOpen(false); setReviewOpen(true); setAdminOpen(false); }}>
                <Clipboard size={15} />
                <span>Review queue</span>
                {reviewBatches.length > 0 && <span className="sidebar-nav-status" />}
              </button>
            )}
            {isAdmin && (
              <button className={`sidebar-nav-item ${adminOpen ? "active" : ""}`} onClick={() => { setChatOpen(false); setContributeOpen(false); setReviewOpen(true); setAdminOpen(true); }}>
                <ShieldCheck size={15} />
                <span>Admin panel</span>
              </button>
            )}
              <button
                className="sidebar-nav-item"
                onClick={openChat}
                title="Open AI chat"
              >
              <MessageCircle size={15} />
              <span>AI chat</span>
              {chatOpen && <span className="sidebar-nav-status" />}
            </button>
          </div>
          <div className="rail-heading">
            <div className="rail-title">
              <Network size={18} />
              <span>Question stream</span>
            </div>
            {questionBankError && <div className="rail-note">{questionBankError}</div>}
            <span className="count-badge">{filtered.length} Qs</span>
          </div>
          <div className="rail-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter questions..."
            />
          </div>
          <div className="rail-filters">
            <SearchableFilter
              value={company}
              options={companies}
              allLabel="All companies"
              placeholder="Search companies..."
              onChange={(nextCompany) => {
                setCompany(nextCompany);
                setDomain("All domains");
                setSelected(null);
              }}
            />
            <SearchableFilter
              value={domain === "All domains" ? "" : domain}
              options={domains}
              allLabel="All domains"
              placeholder="Search domains..."
              searchText={getDomainSearchText}
              onChange={(nextDomain) => setDomain(nextDomain || "All domains")}
            />
          </div>
          <div className="question-list">
            {filtered.slice(0, 250).map((question) => {
              const isActive = selected?.sl_no === question.sl_no;
              const answered = Boolean(answers[String(question.sl_no)]);
              return (
                <button
                  className={`question-row ${isActive ? "is-active" : ""}`}
                  onClick={() => generate(question)}
                  key={String(question.sl_no)}
                >
                  <div className="question-row-top">
                    <span>
                      Q{question.sl_no} ·{" "}
                      {isActive ? "Active" : answered ? "Solved" : "Queued"}
                    </span>
                    <span className="difficulty">
                      {question.domains?.join(", ") || "General"}
                    </span>
                  </div>
                  <p>{question.question}</p>
                  <div className="question-row-meta">
                    {question.company || "General bank"}
                    {question.role ? ` · ${question.role}` : ""}
                    {answered ? <Check size={13} /> : null}
                  </div>
                </button>
              );
            })}
            {filtered.length > 250 && (
              <div className="rail-note">
                Showing the first 250 matches. Narrow the filters to continue.
              </div>
            )}
          </div>
          <div className="calibration">
            <div>
              <span>Session calibration</span>
              <strong>{company ? "Focused track" : "Open exploration"}</strong>
            </div>
            <div className="calibration-bar">
              <span />
            </div>
            <small>{filtered.length} questions available in this view</small>
          </div>
        </aside>

        <section className="focus-stage">
          {!selected && !chatOpen ? (
            <div className="empty-stage">
              <div className="empty-icon">
                <MessageSquare size={28} />
              </div>
              <span className="section-kicker">ANSWER STUDIO</span>
              <h1>Select a question to begin</h1>
              <p>
                Choose a question from the stream and Prep AI will shape a
                response for the selected interview style.
              </p>
            </div>
          ) : (
            <>
              {selected && (
                <>
              <div className="question-header">
                <div className="tag-row">
                  <span className="tag tag-accent">
                    {selected.domains?.join(", ") || "Interview"}
                  </span>
                  <span className="tag">{selected.company || "General"}</span>
                  {selected.role && (
                    <span className="tag">{selected.role}</span>
                  )}
                  <span className="tag tag-status">
                    <span className="status-dot" /> Track #{selected.sl_no}
                  </span>
                </div>
                <h1>{selected.question}</h1>
                <p>
                  {selected.company
                    ? `Prepare a clear, adaptable response for ${selected.company}${selected.role ? ` ${selected.role}` : ""}.`
                    : "Build a concise response you can make your own."}
                </p>
                <div className="style-bar">
                  <div className="style-switcher">
                    {(["interviewee", "normal", "structured"] as Style[]).map(
                      (option) => (
                        <button
                          className={style === option ? "selected" : ""}
                          onClick={() => {
                            setStyle(option);
                            if (selected) void generate(selected, option);
                          }}
                          key={option}
                        >
                          {option === "interviewee"
                            ? "Interviewee style"
                            : option === "normal"
                              ? "Normal style"
                              : "Structured"}
                        </button>
                      ),
                    )}
                  </div>
                  <span className="engine-status">
                    <span className="pulse-dot" /> Gemini answer engine
                  </span>
                </div>
              </div>
              <article className="answer-panel">
                <div className="answer-heading">
                  <div className="answer-identity">
                    <div className="ai-avatar">
                      <Sparkles size={16} />
                    </div>
                    <div>
                      <strong>Prep AI response</strong>
                      <span>
                        {answerSource === "cache"
                          ? "Retrieved from this browser's cache"
                          : answerSource === "redis"
                            ? "Retrieved from shared Redis cache"
                          : answerSource === "generated"
                            ? `Generated for ${style} delivery`
                            : `Ready for ${style} delivery`}
                      </span>
                    </div>
                  </div>
                  <div className="answer-actions">
                    <button className="copy-button" onClick={copyAnswer}>
                      {copied ? <Check size={16} /> : <Clipboard size={16} />}
                      {copied ? "Copied" : "Copy answer"}
                    </button>
                    <button className="read-button" onClick={readAnswerAloud}>
                      <Volume2 size={16} />
                      Read aloud
                    </button>
                    <button className="chat-button" onClick={openChat}>
                      <MessageCircle size={16} />
                      Discuss question
                    </button>
                  </div>
                </div>
                <div className="answer-body">
                  {loading ? (
                    <div className="loading-state">
                      <Loader2 className="spin" size={20} />
                      <span>Drafting a high-signal response...</span>
                    </div>
                  ) : (
                    <>
                      <div className="answer-section">
                        <div className="answer-section-title">
                          <span>01.</span>
                          <h2>Suggested response</h2>
                        </div>
                        <div className="answer-copy">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                          >
                            {normalizeMathDelimiters(
                              answers[String(selected.sl_no)] ||
                                "Your answer will appear here.",
                            )}
                          </ReactMarkdown>
                        </div>
                      </div>
                      <div className="signal-grid">
                        <div>
                          <span>Answer mode</span>
                          <strong>
                            {style === "structured"
                              ? "Four-part format"
                              : style === "normal"
                                ? "Study notes"
                                : "Spoken script"}
                          </strong>
                        </div>
                        <div>
                          <span>Context</span>
                          <strong>
                            {selected.domains?.join(", ") || "General interview"}
                          </strong>
                        </div>
                        <div>
                          <span>Ready state</span>
                          <strong>
                            {answers[String(selected.sl_no)]
                              ? "High signal"
                              : "Waiting"}
                          </strong>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </article>
                </>
              )}
              <AnimatePresence>
              {chatOpen && (
                <motion.section
                  className="chat-screen"
                  aria-label="Question chat"
                  initial={{ opacity: 0, x: 28 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 28 }}
                  transition={{ duration: 0.24, ease: "easeOut" }}
                >
                  <nav className="chat-navbar">
                    <div className="chat-brand">
                      <div className="brand-mark">
                        <Sparkles size={16} />
                      </div>
                      <strong>PREP AI</strong>
                    </div>
                    <div className="chat-nav-links">
                      <button className="chat-nav-link" onClick={() => setChatOpen(false)}>
                        Answer studio
                      </button>
                      <span className="chat-nav-link active">Question chat</span>
                    </div>
                    <button
                      className="chat-close"
                      onClick={() => setChatOpen(false)}
                      aria-label="Close question chat"
                    >
                      ×
                    </button>
                  </nav>
                  <div className="chat-screen-content">
                    <aside className="chat-history" aria-label="Chat history">
                      <button className="chat-new-button" onClick={startNewChat}>
                        <MessageSquare size={15} />
                        New chat
                      </button>
                      <div className="chat-history-heading">
                        <span>Recent chats</span>
                        {authStatus !== "authenticated" && <small>Sign in to save</small>}
                      </div>
                      {authStatus === "authenticated" ? (
                        chatHistoryLoading ? (
                          <div className="chat-history-empty">Loading history...</div>
                        ) : chatHistory.length > 0 ? (
                          <div className="chat-history-list">
                            {chatHistory.map((conversation) => (
                              <button
                                className={`chat-history-item ${chatConversationId === conversation.id ? "active" : ""}`}
                                key={conversation.id}
                                onClick={() => void openPastChat(conversation.id)}
                              >
                                <strong>{conversation.title}</strong>
                                <span>{conversation.context}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="chat-history-empty">Your saved conversations will appear here.</div>
                        )
                      ) : (
                        <div className="chat-history-empty">Guest chats are available for this visit only and are never saved.</div>
                      )}
                    </aside>
                    <div className="chat-conversation">
                    <div className="chat-header">
                      <div>
                        <strong>Question chat</strong>
                        <span>Discuss this question with your AI coach</span>
                      </div>
                    </div>
                  <div className="chat-context">
                    <MessageCircle size={15} />
                    <span>
                      {selected
                        ? selected.question
                        : "General Prep AI chat — ask about any question in the dataset."}
                    </span>
                  </div>
                  <div className="chat-quick-actions">
                    {["Explain this simply", "Give me an example", "Quiz me on this"].map((prompt) => (
                      <button key={prompt} onClick={() => setChatInput(prompt)} disabled={chatLoading}>
                        {prompt}
                      </button>
                    ))}
                  </div>
                  <div className="chat-messages" aria-live="polite">
                    {chatMessages.length === 0 && (
                      <div className="chat-empty">
                        Ask for an explanation, a stronger example, or a more natural way to say the answer.
                      </div>
                    )}
                    {chatMessages.map((message, index) => (
                      <motion.div
                        className={`chat-message ${message.role}`}
                        key={`${message.role}-${index}`}
                        initial={{ opacity: 0, y: 10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ duration: 0.22, delay: Math.min(index * 0.025, 0.2) }}
                      >
                        <span>{message.role === "user" ? "You" : "Prep AI"}</span>
                        <div className="chat-message-content">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkMath]}
                            rehypePlugins={[rehypeKatex]}
                          >
                            {normalizeMathDelimiters(message.content)}
                          </ReactMarkdown>
                        </div>
                      </motion.div>
                    ))}
                    {chatLoading && (
                      <div className="chat-loading">
                        <Loader2 className="spin" size={16} /> Thinking...
                      </div>
                    )}
                  </div>
                  <form className="chat-form" onSubmit={sendChat}>
                    <textarea
                      value={chatInput}
                      onChange={(event) => setChatInput(event.target.value)}
                      placeholder="Ask about any interview question..."
                      rows={2}
                      disabled={chatLoading}
                    />
                    <button type="submit" disabled={chatLoading || !chatInput.trim()}>
                      Send
                    </button>
                  </form>
                  </div>
                  </div>
                </motion.section>
              )}
              </AnimatePresence>
            </>
          )}
        </section>
      </div>
      {contributeOpen && (
        <section className="contribution-panel" aria-label="Contribute questions">
          <div className="contribution-heading">
            <div>
              <span className="section-kicker">CONTRIBUTION PIPELINE</span>
              <h1>Contribute questions</h1>
              <p>Paste one question per line or upload a CSV, XLSX, or TXT file. Prep AI will normalize questions, suggest metadata, and check duplicates before review.</p>
            </div>
            <button className="chat-close" onClick={() => setContributeOpen(false)} aria-label="Close contribution form">×</button>
          </div>
          <div className="contribution-form">
            <label>Company name<input value={contributionCompany} onChange={(event) => setContributionCompany(event.target.value)} placeholder="e.g. Acme Corp" /></label>
            <label>Job role (optional)<input value={contributionRole} onChange={(event) => setContributionRole(event.target.value)} placeholder="e.g. Software Engineer" /></label>
            <label>Domain (optional)<input value={contributionDomain} onChange={(event) => setContributionDomain(event.target.value)} placeholder="AI will suggest one if blank" /></label>
            <label>Tags (optional)<input value={contributionTags} onChange={(event) => setContributionTags(event.target.value)} placeholder="comma-separated, e.g. processes, threads" /></label>
          </div>
          <label className="contribution-upload">
            <FileUp size={18} />
            <span>{contributionFile || "Upload CSV, XLSX, or TXT"}</span>
            <input
              type="file"
              accept=".csv,.xlsx,.txt,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setContributionFile(file.name);
                try {
                  await readContributionFile(file);
                } catch (error) {
                  alert(error instanceof Error ? error.message : "Unable to read this file.");
                }
              }}
            />
          </label>
          <label>Questions<textarea value={contributionText} onChange={(event) => { setContributionFileType("text"); setContributionImportedItems([]); setContributionText(event.target.value); }} rows={9} placeholder={"Paste one question per line...\nWhat is the difference between a process and a thread?"} /></label>
          <div className="contribution-actions">
            <button className="export-button" onClick={() => void submitContribution()} disabled={contributionLoading}>
              {contributionLoading ? <Loader2 className="spin" size={16} /> : <FileUp size={16} />} Submit for review
            </button>
            <span>Maximum 100 questions per batch</span>
          </div>
          {contributionResult && (
            <div className="contribution-result">
              <strong>Batch {contributionResult.status.replace("_", " ")}</strong>
              <p>Each question has been normalized and checked against the live question bank. A reviewer must approve publishable questions.</p>
              <div className="contribution-items">
                {contributionResult.items.map((item, index) => (
                  <div key={`${item.question}-${index}`}>
                    <span>{item.exactDuplicate ? "Exact duplicate" : item.similarityScore > 0.9 ? "High similarity" : item.similarityScore >= 0.82 ? "Review" : "Ready for review"}</span>
                    <p>{item.question}</p>
                    {item.nearestMatch && <small>Closest match ({item.nearestMatch.company}): {item.nearestMatch.question} · {item.nearestMatch.score.toFixed(2)}</small>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}
      {reviewOpen && authStatus === "authenticated" && (
        <section className="review-screen" aria-label="Contribution review queue">
          {adminOpen && adminData && (
            <section className="admin-panel" aria-label="Admin panel">
              <div className="admin-header">
                <div>
                  <span className="section-kicker">SYSTEM ADMINISTRATION</span>
                  <h1>Prep AI admin panel</h1>
                  <p>Manage contribution policy, monitor the live bank, and moderate every submitted question.</p>
                </div>
                <Settings size={30} />
              </div>
              <div className="admin-metrics">
                <div><strong>{adminData.stats.questionCount}</strong><span>Live questions</span></div>
                <div><strong>{adminData.stats.pending}</strong><span>Pending batches</span></div>
                <div><strong>{adminData.stats.published}</strong><span>Published logs</span></div>
                <div><strong>{adminData.stats.rejected}</strong><span>Rejected logs</span></div>
              </div>
              <div className="admin-columns">
                <div className="admin-settings-card">
                  <span className="section-kicker">APPROVAL POLICY</span>
                  <h2>Duplicate safeguards</h2>
                  <label>Manual review threshold<input type="number" min="0" max="1" step="0.01" value={adminSettings.duplicateReviewThreshold} onChange={(event) => setAdminSettings((current) => ({ ...current, duplicateReviewThreshold: Number(event.target.value) }))} /></label>
                  <label>Automatic block threshold<input type="number" min="0" max="1" step="0.01" value={adminSettings.duplicateBlockThreshold} onChange={(event) => setAdminSettings((current) => ({ ...current, duplicateBlockThreshold: Number(event.target.value) }))} /></label>
                  <label className="admin-toggle"><input type="checkbox" checked={adminSettings.autoPublishLowRisk} onChange={(event) => setAdminSettings((current) => ({ ...current, autoPublishLowRisk: event.target.checked }))} /> Allow low-risk auto-publish</label>
                  <button className="export-button" onClick={() => void saveAdminSettings()} disabled={adminSaving}>{adminSaving ? <Loader2 className="spin" size={15} /> : <Settings size={15} />} Save settings</button>
                  <small>Thresholds are similarity scores from 0 to 1. Auto-publish remains disabled by default.</small>
                </div>
                <div className="admin-audit-card">
                  <span className="section-kicker">RECENT ACTIVITY</span>
                  <h2>Decision log</h2>
                  {adminData.audit.length ? adminData.audit.map((entry) => <div className="admin-audit-row" key={String(entry._id)}><strong>{entry.action}</strong><span>{entry.company}</span><small>{entry.reviewerEmail} · {new Date(entry.createdAt).toLocaleString()}</small></div>) : <p>No decisions logged yet.</p>}
                </div>
              </div>
              <div className="admin-review-callout"><div><strong>Moderation queue</strong><span>{adminData.stats.pending} batch{adminData.stats.pending === 1 ? "" : "es"} require review</span></div><button className="review-approve" onClick={() => setAdminOpen(false)}>Open approval queue below</button></div>
            </section>
          )}
          <div className="review-header">
            <div>
              <span className="section-kicker">MODERATION WORKSPACE</span>
              <h1>Review contributions</h1>
              <p>Inspect every submission, correct its metadata, and approve only questions that are ready for the live question bank.</p>
            </div>
            <div className="review-summary">
              <strong>{reviewBatches.length}</strong>
              <span>pending batches</span>
            </div>
          </div>
          {reviewLoading ? (
            <div className="review-empty"><Loader2 className="spin" size={22} /> Loading review queue...</div>
          ) : reviewBatches.length === 0 ? (
            <div className="review-empty"><Clipboard size={28} /><strong>Queue is clear</strong><span>New contribution batches awaiting review will appear here.</span></div>
          ) : (
            <div className="review-layout">
              <aside className="review-batches">
                {reviewBatches.map((batch) => (
                  <button
                    key={batch._id}
                    className={`review-batch ${selectedReviewBatch === batch._id ? "active" : ""}`}
                    onClick={() => setSelectedReviewBatch(batch._id)}
                  >
                    <span>{batch.company}</span>
                    <strong>{batch.items.length} question{batch.items.length === 1 ? "" : "s"}</strong>
                    <small>{new Date().toLocaleDateString()}</small>
                  </button>
                ))}
              </aside>
              <div className="review-items">
                {(reviewBatches.find((batch) => batch._id === (selectedReviewBatch || reviewBatches[0]?._id)) || reviewBatches[0]) && (() => {
                  const batch = reviewBatches.find((item) => item._id === selectedReviewBatch) || reviewBatches[0];
                  const publishable = batch.items
                    .map((item, index) => ({ item, index }))
                    .filter(({ item }) => item.reviewStatus === "approved" && item.preprocessingStatus !== "failed" && !item.exactDuplicate && item.similarityScore <= (adminData?.settings.duplicateBlockThreshold ?? 0.9))
                    .map(({ index }) => index);
                  return (
                    <>
                      <div className="review-batch-heading">
                        <div><span className="section-kicker">BATCH</span><h2>{batch.company}</h2><p>{batch.items.length} submitted questions · review each item before publishing</p></div>
                        <div className="review-batch-actions">
                          <button className="export-button" onClick={() => void reviewBatch(batch._id, "publish", publishable)} disabled={!publishable.length || reviewSaving === `${batch._id}:publish`}>{reviewSaving === `${batch._id}:publish` ? <Loader2 className="spin" size={15} /> : <Check size={15} />} Publish approved</button>
                          <button className="review-reject-button" onClick={() => void reviewBatch(batch._id, "reject")} disabled={reviewSaving === `${batch._id}:reject`}>Reject batch</button>
                        </div>
                      </div>
                      {batch.items.map((item, index) => {
                        const draftKey = `${batch._id}:${index}`;
                        const draft = reviewDrafts[draftKey] || item;
                        const blocked = item.preprocessingStatus === "failed" || item.exactDuplicate || item.similarityScore > 0.9;
                        return (
                          <article className={`review-card ${item.reviewStatus === "approved" ? "approved" : item.reviewStatus === "rejected" ? "rejected" : ""}`} key={draftKey}>
                            <div className="review-card-top">
                              <div><span className="review-index">Q{index + 1}</span><span className={`review-status ${blocked ? "blocked" : item.reviewStatus || "pending"}`}>{blocked ? "Blocked" : item.reviewStatus || "Pending review"}</span></div>
                              <span className="review-score">{item.exactDuplicate ? "Exact duplicate" : `Similarity ${(item.similarityScore * 100).toFixed(0)}%`}</span>
                            </div>
                            <div className="review-original"><span>ORIGINAL SUBMISSION</span><p>{item.originalText}</p></div>
                            <div className="review-editor-grid">
                              <label className="review-field-wide">Formatted question<textarea value={draft.question} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, question: event.target.value } }))} rows={3} /></label>
                              <label>Company<input value={draft.company} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, company: event.target.value } }))} /></label>
                              <label>Job role<input value={draft.role} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, role: event.target.value } }))} /></label>
                              <label>Domain<input value={draft.domain} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, domain: event.target.value } }))} /></label>
                              <label>Difficulty<select value={draft.difficulty || ""} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, difficulty: event.target.value } }))}><option value="">Not set</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></label>
                              <label className="review-field-wide">Tags<input value={draft.tags.join(", ")} onChange={(event) => setReviewDrafts((current) => ({ ...current, [draftKey]: { ...draft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) } }))} /></label>
                            </div>
                            {item.nearestMatch && <div className="review-match"><span>CLOSEST EXISTING MATCH · {item.nearestMatch.company} · {(item.nearestMatch.score * 100).toFixed(0)}%</span><p>{item.nearestMatch.question}</p></div>}
                            {item.reviewNote && <div className="review-note">{item.reviewNote}</div>}
                            <div className="review-card-actions">
                              <button className="review-save" onClick={() => { setReviewDrafts((current) => ({ ...current, [draftKey]: draft })); void reviewBatch(batch._id, "edit", undefined, index, draft); }} disabled={!draft.question.trim() || !draft.company.trim() || reviewSaving === draftKey}>{reviewSaving === draftKey ? <Loader2 className="spin" size={14} /> : null} Save changes</button>
                              <button className="review-approve" onClick={() => void reviewBatch(batch._id, "approve", undefined, index)} disabled={blocked || reviewSaving === `${batch._id}:${index}`}>Approve item</button>
                              <button className="review-reject-item" onClick={() => void reviewBatch(batch._id, "reject_item", undefined, index)} disabled={reviewSaving === `${batch._id}:${index}`}>Reject item</button>
                            </div>
                          </article>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </section>
      )}
      {authOpen && (
        <div className="auth-backdrop" role="dialog" aria-modal="true" aria-label="Account authentication">
          <div className="auth-modal">
            <button className="auth-modal-close" onClick={() => setAuthOpen(false)} aria-label="Close authentication">×</button>
            <div className="section-kicker">PREP AI ACCOUNT</div>
            <h2>{authView === "signin" ? "Welcome back" : "Create your account"}</h2>
            <p>{authView === "signin" ? "Sign in to save and continue your question chats." : "Create an account to keep your chat sessions private."}</p>
            <form className="auth-form" onSubmit={submitAuth}>
              {authView === "signup" && (
                <label className="auth-field">
                  <span>Name</span>
                  <div className="auth-input-wrap">
                    <UserRound size={16} />
                    <input value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="Your name" autoComplete="name" required />
                  </div>
                </label>
              )}
              <label className="auth-field">
                <span>Email</span>
                <div className="auth-input-wrap">
                  <Mail size={16} />
                  <input value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} type="email" placeholder="you@example.com" autoComplete="email" required />
                </div>
              </label>
              <label className="auth-field">
                <span>Password</span>
                <div className="auth-input-wrap">
                  <LockKeyhole size={16} />
                  <input value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} type="password" placeholder={authView === "signin" ? "Your password" : "At least 8 characters"} autoComplete={authView === "signin" ? "current-password" : "new-password"} minLength={8} required />
                </div>
              </label>
              {authError && <span className="auth-error">{authError}</span>}
              <button type="submit" disabled={authLoading}>{authLoading ? "Working..." : authView === "signin" ? "Sign in" : "Create account"}</button>
            </form>
            <button className="auth-switch" onClick={() => { setAuthView(authView === "signin" ? "signup" : "signin"); setAuthError(""); }}>
              {authView === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (match) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[match],
  );
}
function nl2br(value: string) {
  return value.replace(/\n/g, "<br/>");
}
