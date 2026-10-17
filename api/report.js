const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const ALLOWED_CATEGORIES = new Set(["plastic", "paper", "metal", "glass", "organic", "hazardous", "unknown"]);
const ALLOWED_STAGES = new Set(["identified", "sorted", "recovery", "reuse"]);
const ASSESSMENT_ANSWERS = {
  plastic: {
    condition: ["intact", "cracked", "broken", "unknown"],
    empty: ["yes", "no", "unknown"],
    previousContents: ["water", "food", "cleaner", "other", "unknown"],
  },
  paper: {
    condition: ["clean", "wet", "greasy", "unknown"],
    coating: ["no", "yes", "unknown"],
  },
  metal: {
    empty: ["yes", "no", "unknown"],
    sharpEdges: ["no", "yes", "unknown"],
    pressurized: ["no", "yes", "unknown"],
  },
  glass: {
    condition: ["intact", "cracked", "broken", "unknown"],
    empty: ["yes", "no", "unknown"],
    previousContents: ["food", "drink", "chemical", "other", "unknown"],
  },
  organic: { contamination: ["no", "yes", "unknown"] },
  hazardous: { hazardCondition: ["normal", "damaged", "swollen", "leaking", "hot", "unknown"] },
  unknown: {},
};

function sendJson(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

function cleanText(value, fallback, maxLength = 600) {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength) || fallback;
}

function readInput(request) {
  if (request.body !== undefined) {
    try {
      return Promise.resolve(typeof request.body === "string" ? JSON.parse(request.body) : request.body);
    } catch {
      return Promise.reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
    }
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > 4 * 1024 * 1024) {
        reject(Object.assign(new Error("Report request exceeds the 4 MB limit."), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (total > 4 * 1024 * 1024) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function sanitizeRecords(input) {
  if (!input || !Array.isArray(input.records) || input.records.length > 500) {
    throw Object.assign(new Error("Report requests must include a records array with no more than 500 entries."), { status: 400 });
  }
  const records = input.records.map((record) => {
    if (!record || !ALLOWED_CATEGORIES.has(record.category) || !ALLOWED_STAGES.has(record.status)) {
      throw Object.assign(new Error("A report record contains an unsupported category or lifecycle stage."), { status: 400 });
    }
    const answers = ASSESSMENT_ANSWERS[record.category];
    const userProvidedConditionAnswers = Object.fromEntries(
      Object.entries(answers)
        .filter(([key, allowed]) => allowed.includes(record.assessment?.answers?.[key]))
        .map(([key]) => [key, record.assessment.answers[key]])
    );
    const events = Array.isArray(record.events)
      ? record.events.slice(0, 50).filter((event) =>
        event && ALLOWED_STAGES.has(event.status) && typeof event.at === "string" && !Number.isNaN(Date.parse(event.at))
      ).map((event) => ({
        status: event.status,
        at: new Date(event.at).toISOString(),
        note: cleanText(event.note, "Lifecycle event recorded", 120),
      }))
      : [];
    const safeRecord = {
      id: cleanText(record.id, "record id not recorded", 100),
      category: record.category,
      itemName: cleanText(record.itemName, "Unidentified item", 100),
      status: record.status,
      source: record.source === "ai-model" ? "AI-assisted visual review" : record.source === "manual-review" ? "manual review" : "sample data",
      createdAt: typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt))
        ? new Date(record.createdAt).toISOString()
        : null,
      analysisAt: typeof record.analysisAt === "string" && !Number.isNaN(Date.parse(record.analysisAt))
        ? new Date(record.analysisAt).toISOString()
        : null,
      analysisModel: cleanText(record.analysisModel, "not recorded", 80),
      userProvidedConditionAnswers,
      events,
      eventCount: events.length,
    };
    if (record.source === "ai-model" && record.aiSummary && typeof record.aiSummary === "object") {
      const confidence = Number(record.aiSummary.confidence);
      safeRecord.aiEstimate = {
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        confidenceBasis: cleanText(record.aiSummary.confidenceBasis, "not recorded", 40),
        confidenceReason: cleanText(record.aiSummary.confidenceReason, "Not recorded", 240),
        visualEvidence: Array.isArray(record.aiSummary.visualEvidence)
          ? record.aiSummary.visualEvidence.filter((item) => typeof item === "string").slice(0, 4).map((item) => cleanText(item, "", 160))
          : [],
        alternativeCategories: Array.isArray(record.aiSummary.alternativeCategories)
          ? record.aiSummary.alternativeCategories.filter((category) => ALLOWED_CATEGORIES.has(category)).slice(0, 3)
          : [],
        needsReview: record.aiSummary.needsReview === true,
        hazardous: record.aiSummary.hazardous === true,
        itemName: cleanText(record.aiSummary.itemName, safeRecord.itemName, 100),
        material: cleanText(record.aiSummary.material, "Not recorded", 120),
        condition: cleanText(record.aiSummary.condition, "Unknown", 40),
        action: cleanText(record.aiSummary.action, "No action recorded", 300),
        preparation: cleanText(record.aiSummary.preparation, "No preparation advice recorded", 300),
        reuseOption: cleanText(record.aiSummary.reuseOption, "No reuse suggestion recorded", 200),
        explanation: cleanText(record.aiSummary.explanation, "No visual evidence note recorded", 300),
        caveat: cleanText(record.aiSummary.caveat, "AI visual estimate only; local disposal rules are not verified.", 300),
      };
    }
    if (record.detailedAnalysis && typeof record.detailedAnalysis === "object") {
      const detailed = record.detailedAnalysis;
      const summary = detailed.item_summary && typeof detailed.item_summary === "object" ? detailed.item_summary : {};
      safeRecord.detailedSummary = {
        reportStatus: typeof detailed.report_status === "string" ? detailed.report_status.slice(0, 40) : "unknown",
        itemName: cleanText(summary.item_name && summary.item_name.value, safeRecord.itemName, 100),
        category: cleanText(summary.category, record.category, 40),
        recommendation: cleanText(summary.primary_recommendation, "", 300),
        openInputs: Array.isArray(detailed.required_user_inputs)
          ? detailed.required_user_inputs.filter((item) => item && typeof item.question === "string").slice(0, 8).map((item) => cleanText(item.question, "", 200))
          : [],
      };
    }
    return safeRecord;
  });
  const countValues = (field, values) => Object.fromEntries(values.map((value) => [
    value,
    records.filter((record) => record[field] === value).length,
  ]));
  const aiRecords = records.filter((record) => record.aiEstimate);
  return {
    projectName: "EcoSnapAI",
    track: "Smart Recycling Assistant",
    records,
    summary: {
      recordCount: records.length,
      categoryCounts: countValues("category", [...ALLOWED_CATEGORIES]),
      stageCounts: countValues("status", [...ALLOWED_STAGES]),
      sourceCounts: countValues("source", ["AI-assisted visual review", "manual review", "sample data"]),
      aiEstimateCount: aiRecords.length,
      aiReviewRecommendedCount: aiRecords.filter((record) => record.aiEstimate.needsReview).length,
      potentiallyHazardousAiEstimateCount: aiRecords.filter((record) => record.aiEstimate.hazardous).length,
      eventCount: records.reduce((total, record) => total + record.eventCount, 0),
    },
    generatedAt: new Date().toISOString(),
  };
}

async function generateReport(safeInput) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Gemini is not configured on the server."), { status: 503 });
  const models = [...new Set([process.env.GEMINI_MODEL || "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"])];
  let lastStatus = 0;
  let lastMessage = "";
  for (const model of models) {
    let response;
    try {
      response = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{
              text: `Write a detailed, clear, item-focused Smart Recycling report in Markdown for EcoSnapAI.
The sanitized JSON below is the complete source of saved-record facts. Original photos are not sent. Describe recorded model fields only as visual estimates.
Condition answers are user-provided self-reports, not AI observations. Never weaken safety guidance for batteries, chemicals, sharp/broken items, pressurized containers, damage, leakage, swelling, heat, or unknown contents. Never recommend opening, testing, repairing, or repurposing hazardous items.
Include an executive summary with exact record and AI-estimate counts; an itemized table; a clearly labelled subsection for each saved item with actual category/name, confidence, visible material, condition, evidence, recorded advice, follow-up questions and analysis time/model; simulated journey stage and event history; practical next steps without inventing local rules; safety and uncertainty notes; unavailable impact/weight values as "Insufficient data to calculate"; provenance; limitations; and a final action checklist.
If there is one item, prioritize its actual details. If there are no records, state that plainly and do not invent examples. Describe confidence as an unvalidated AI visual evidence score, never a probability of correctness.
Every lifecycle stage is simulated. Do not claim any item was actually recycled, collected, reused, composted, diverted, or processed. Do not invent confidence, environmental statistics, impact, local rules, facilities, accuracy, or system capabilities. Treat potentially hazardous or uncertain items conservatively.
Data to report (counts and sanitized record fields are authoritative):
${JSON.stringify(safeInput, null, 2)}

Return JSON only in this exact shape: {"reportMarkdown":"...the complete Markdown report as a JSON string..."}.`,
            }],
          }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 4096 },
        }),
      });
    } catch (error) {
      lastStatus = error.name === "TimeoutError" || error.name === "AbortError" ? 504 : 502;
      lastMessage = error.message;
      continue;
    }
    const payload = await response.json().catch(() => null);
    if (response.ok) {
      const text = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
      if (!text) throw Object.assign(new Error("Gemini returned an empty report."), { status: 502 });
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        throw Object.assign(new Error("Gemini returned an unreadable report. Please retry."), { status: 502 });
      }
      if (typeof result.reportMarkdown !== "string" || result.reportMarkdown.trim().length < 100) {
        throw Object.assign(new Error("The model did not return a complete report. Please retry."), { status: 502 });
      }
      const reportMarkdown = result.reportMarkdown.trim();
      const unsupportedClaims = [
        /\bReact(?: Native)?\b/i,
        /\bFirebase\b|\bFirestore\b/i,
        /\bground[- ]truth dataset of \d+/i,
        /\b(?:carbon footprint|carbon savings|contamination reduction|waste diversion)\s+(?:has been|was|is)\s+(?:reduced|achieved|measured)\b/i,
      ];
      if (unsupportedClaims.some((pattern) => pattern.test(reportMarkdown))) {
        throw Object.assign(new Error("Gemini returned unsupported project details. A verified local report will be shown instead."), { status: 502 });
      }
      const verifiedRecordDetails = safeInput.records.length
        ? safeInput.records.map((record) => {
          const conditionDetails = Object.keys(record.userProvidedConditionAnswers).length
            ? ` User-provided condition answers (not AI observations): ${JSON.stringify(record.userProvidedConditionAnswers)}.`
            : " No user-provided condition answers are recorded.";
          const aiDetails = record.aiEstimate
            ? ` AI estimate: material ${record.aiEstimate.material}; condition ${record.aiEstimate.condition}; visual evidence score ${record.aiEstimate.confidence === null ? "not recorded" : `${Math.round(record.aiEstimate.confidence * 100)}%`} (${record.aiEstimate.confidenceBasis}: ${record.aiEstimate.confidenceReason}); visible cues ${record.aiEstimate.visualEvidence.join("; ") || "not recorded"}; alternatives ${record.aiEstimate.alternativeCategories.join(", ") || "none reported"}; human review ${record.aiEstimate.needsReview ? "recommended" : "not flagged"}; safety flag ${record.aiEstimate.hazardous ? "present" : "not flagged"}; next step ${record.aiEstimate.action}; preparation ${record.aiEstimate.preparation}; reuse ${record.aiEstimate.reuseOption}; visual note ${record.aiEstimate.explanation}.`
            : "";
          const detailedDetails = record.detailedSummary
            ? ` Detailed analysis (AI estimate): status ${record.detailedSummary.reportStatus}; recommendation ${record.detailedSummary.recommendation || "not recorded"}${record.detailedSummary.openInputs.length ? `; open follow-up questions: ${record.detailedSummary.openInputs.join(" | ")}` : ""}.`
            : "";
          return `- **${record.itemName}** — category: ${record.category}; lifecycle: ${record.status} (simulated); source: ${record.source}; events: ${record.eventCount}.${conditionDetails}${aiDetails}${detailedDetails}`;
        }).join("\n")
        : "- No browser records were supplied.";
      return {
        report: `${reportMarkdown}\n\n## Validated browser record details\nThese details are included directly from the sanitized input records; lifecycle stages remain simulated.\n\n${verifiedRecordDetails}`.slice(0, 30000),
        model,
      };
    }
    lastStatus = response.status;
    lastMessage = payload?.error?.message || "";
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("Gemini rejected the API key. Check its API access."), { status: 502 });
    }
    if (![404, 429, 500, 502, 503].includes(response.status)) break;
  }
  if (lastStatus === 429) throw Object.assign(new Error("Gemini rate limit or quota reached. Check your Google AI Studio quota and retry later."), { status: 429 });
  if (lastStatus === 503) throw Object.assign(new Error("Google Gemini is overloaded right now. Try again shortly, or use Build offline report."), { status: 503 });
  if (lastStatus === 504) throw Object.assign(new Error("Gemini timed out. Please retry shortly."), { status: 504 });
  console.error("Gemini report model options failed.", { status: lastStatus, message: lastMessage || "No provider message" });
  throw Object.assign(new Error("No configured Gemini model is available for this API key."), { status: 502 });
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }
  if (!String(request.headers["content-type"] || "").includes("application/json")) {
    sendJson(response, 415, { error: "Send this request as application/json." });
    return;
  }
  let input;
  try {
    input = await readInput(request);
  } catch (error) {
    sendJson(response, error.status || 400, { error: error.message || "Could not read request body." });
    return;
  }
  try {
    const safeInput = sanitizeRecords(input);
    const result = await generateReport(safeInput);
    sendJson(response, 200, {
      report: result.report,
      model: result.model,
      basedOn: { recordCount: safeInput.records.length, generatedAt: safeInput.generatedAt },
    });
  } catch (error) {
    console.error("EcoSnapAI report generation failed.", error.message);
    sendJson(response, error.status || 502, { error: error.message || "Report generation failed." });
  }
};
