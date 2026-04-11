// src/insights/community-pulse.js
const DAY = 86400;
const WEEK = 7 * DAY;
const log = require("../logger");

function stripHtml(html) {
  return (html || "").replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ").trim();
}

module.exports = {
  id: "community-pulse",
  name: "Community Pulse",
  needsOllama: true,

  shouldRun(db, lastRun) {
    const now = Math.floor(Date.now() / 1000);
    if (lastRun && lastRun.status === "done" && (now - lastRun.completed_at) < WEEK) return [];
    const from = lastRun ? lastRun.period_to : now - WEEK;
    return [{ from, to: now }];
  },

  async run(db, connector, period, runId) {
    const comments = db.getCommentsForRelevantStories(period.from, period.to);
    if (comments.length === 0) return null;

    log.info(`Community Pulse: analyzing ${comments.length} comments...`);

    // ── Layer 1: Signal extraction (per comment) ──
    const signals = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const text = stripHtml(c.text);
      if (!text || text.length < 10) continue;

      // Build parent chain context
      const parents = db.getCommentParentChain(c.parent_id, c.story_id, 3);
      const parentContext = parents.length > 0
        ? parents.map((p) => `${p.author}: ${stripHtml(p.text).slice(0, 150)}`).join("\n→ ")
        : "";

      const prompt = `Story: "${c.story_title}"${c.story_summary ? "\nSummary: " + c.story_summary : ""}
${parentContext ? "\nThread:\n" + parentContext + "\n→ " : "\n"}${c.author}: ${text}

Extract a structured signal from this comment. Output ONLY JSON:
{"claims":["..."],"stance":"...","experience_level":"observer|user|practitioner|builder","action_taken":"...","topics_referenced":["..."]}`;

      const result = await connector.chat(
        "You extract structured signals from tech discussion comments. Output ONLY valid JSON.",
        prompt,
        { temperature: 0, maxTokens: 300, timeout: 60000 }
      );

      if (result) {
        try {
          const match = result.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            signals.push({ commentId: c.id, author: c.author, storyTitle: c.story_title, ...parsed });
            if (runId) db.saveCommentSignal(c.id, runId, JSON.stringify(parsed));
          }
        } catch (err) {
          log.warn(`Community Pulse: layer 1 JSON parse failed: ${err.message}`);
        }
      }

      if ((i + 1) % 50 === 0) log.dim(`  Layer 1: ${i + 1}/${comments.length} comments processed`);
    }

    if (signals.length === 0) return null;

    log.info(`Community Pulse: ${signals.length} signals extracted, discovering narratives...`);

    // ── Layer 2: Narrative discovery ──
    const signalsBlock = signals.map((s) =>
      `[${s.storyTitle.slice(0, 40)}] ${s.author} (${s.experience_level}): stance="${s.stance}", claims=[${(s.claims || []).join("; ")}], topics=[${(s.topics_referenced || []).join(", ")}]`
    ).join("\n");

    const narrativeResult = await connector.chat(
      "You analyze patterns in community reactions to tech topics. Output ONLY valid JSON.",
      `Here are ${signals.length} comment signals from this week's tech discussions:

${signalsBlock}

Identify the dominant narratives. Group by topic. For each:
- What topic/theme?
- How many comments relate?
- What's the dominant stance?
- Energy level (high/medium/low)?
- Key claims?

Return JSON: {"narratives":[{"topic":"...","comment_count":N,"dominant_stance":"...","energy":"high|medium|low","key_claims":["..."]}]}`,
      { temperature: 0.3, maxTokens: 1500, timeout: 180000 }
    );

    let narratives = [];
    if (narrativeResult) {
      try {
        const match = narrativeResult.match(/\{[\s\S]*\}/);
        if (match) narratives = JSON.parse(match[0]).narratives || [];
      } catch (err) {
        log.warn(`Community Pulse: layer 2 JSON parse failed: ${err.message}`);
      }
    }

    if (narratives.length === 0) return null;

    // ── Layer 3: Week-over-week comparison ──
    const lastRunData = db.getLastCompletedRun("community-pulse");
    let comparison = "";
    if (lastRunData && lastRunData.result_summary) {
      try {
        const prev = JSON.parse(lastRunData.result_summary);
        const prevBlock = (prev.narratives || []).map((n) =>
          `${n.topic}: ${n.dominant_stance} (${n.energy} energy, ${n.comment_count} comments)`
        ).join("\n");

        const currBlock = narratives.map((n) =>
          `${n.topic}: ${n.dominant_stance} (${n.energy} energy, ${n.comment_count} comments)`
        ).join("\n");

        const compResult = await connector.chat(
          "You compare weekly community reactions. Be concise. 2-3 sentences per topic.",
          `Last week:\n${prevBlock}\n\nThis week:\n${currBlock}\n\nWhat shifted? What's new? What faded? One paragraph per topic.`,
          { temperature: 0.3, maxTokens: 1000, timeout: 120000 }
        );
        if (compResult) comparison = compResult;
      } catch (err) {
        log.warn(`Community Pulse: layer 3 comparison failed: ${err.message}`);
      }
    }

    // Build final message
    const lines = narratives.map((n) => {
      const claims = (n.key_claims || []).slice(0, 2).join("; ");
      return `<b>${n.topic}</b>\n${n.comment_count} comments, ${n.energy} energy\n${n.dominant_stance}${claims ? "\nKey: " + claims : ""}`;
    });

    let message = lines.join("\n\n");
    if (comparison) message += "\n\n<b>Shifts</b>\n" + comparison;

    return {
      summary: JSON.stringify({ narratives }),
      narratives,
      message,
    };
  },

  format(result) {
    return `🧠 <b>Community Pulse</b>\n\n${result.message}`;
  },
};
