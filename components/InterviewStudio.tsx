"use client";

import { useMemo, useState } from "react";
import questions from "../public/questions.json";
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
  Loader2,
  MessageSquare,
  Network,
  Search,
  Sparkles,
  Volume2,
} from "lucide-react";

type Q = {
  sl_no: number | string;
  question: string;
  company: string;
  role: string;
  domain: string;
};
type Style = "interviewee" | "normal" | "structured";
type AnswerCache = Record<string, string>;

const qs = questions as Q[];
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

function getAnswerCacheKey(question: Q, style: Style) {
  return JSON.stringify([
    String(question.sl_no),
    question.question,
    question.company,
    question.role,
    question.domain,
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
              {question.domain}
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
  const companies = useMemo(
    () => unique(qs.map((question) => question.company)),
    [],
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
  const domains = useMemo(
    () =>
      unique(
        qs
          .filter((question) => !company || question.company === company)
          .map((question) => question.domain),
      ),
    [company],
  );
  const filtered = useMemo(() => {
    const term = normalize(search);
    return qs.filter(
      (question) =>
        (!company || question.company === company) &&
        (domain === "All domains" || question.domain === domain) &&
        (!term ||
          normalize(question.question).includes(term) ||
          normalize(question.domain).includes(term)),
    );
  }, [company, domain, search]);

  async function generate(question: Q, responseStyle: Style = style) {
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
          domain: question.domain,
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
            domain: question.domain,
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
              domain: question.domain,
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

  return (
    <main className="studio-shell">
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
      </header>

      <div className="studio-layout">
        <aside className="navigator-rail">
          <div className="rail-heading">
            <div className="rail-title">
              <Network size={18} />
              <span>Question stream</span>
            </div>
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
            <select
              value={company}
              onChange={(event) => {
                setCompany(event.target.value);
                setDomain("All domains");
                setSelected(null);
              }}
            >
              <option value="">All companies</option>
              {companies.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <select
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            >
              <option>All domains</option>
              {domains.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
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
                      {question.domain || "General"}
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
          {!selected ? (
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
              <div className="question-header">
                <div className="tag-row">
                  <span className="tag tag-accent">
                    {selected.domain || "Interview"}
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
                            {selected.domain || "General interview"}
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
        </section>
      </div>
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
