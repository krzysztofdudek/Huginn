# Reliable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Telegram message is persisted in the database with individual sent/unsent tracking, so failed sends are retried without losing content or duplicating messages.

**Architecture:** New `delivery_messages` table stores individual Telegram messages with a `sent` flag and sequence number. Each delivery (briefing, weekly, etc.) produces 1+ messages. `delivery.js` builds messages from raw delivery data and saves them before attempting to send. A single `flushUnsent` loop sends all pending messages in order. Parent `deliveries` row is marked sent only when all its messages are delivered.

**Tech Stack:** SQLite (better-sqlite3), existing codebase patterns.

---

## File Structure

- **Modify:** `src/db.js` — migration #3 (new table + column), new query functions
- **Modify:** `src/intelligence.js` — save `stories_json` alongside delivery content
- **Modify:** `src/delivery.js` — refactor all `deliver*` functions to save messages to DB first, then send; rewrite `flushUnsent`
- **Modify:** `src/index.js` — `--reset` must also clear `delivery_messages`; adjust intelligence phase to separate message creation from sending

---

### Task 1: Database migration — `delivery_messages` table + `stories_json` column

**Files:**
- Modify: `src/db.js:19-128` (MIGRATIONS array)
- Modify: `src/db.js:394-419` (delivery query functions)
- Modify: `src/db.js:606-624` (module.exports)

- [ ] **Step 1: Add migration #3**

Add to the `MIGRATIONS` array in `src/db.js`:

```js
{
  version: 3,
  name: "delivery_messages",
  up: `
    CREATE TABLE IF NOT EXISTS delivery_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      sent_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dm_delivery ON delivery_messages(delivery_id);
    CREATE INDEX IF NOT EXISTS idx_dm_unsent ON delivery_messages(sent, created_at);

    ALTER TABLE deliveries ADD COLUMN stories_json TEXT;
  `,
},
```

- [ ] **Step 2: Add DB functions for delivery_messages**

Add these functions to `src/db.js` in the Deliveries section:

```js
function saveDeliveryMessages(deliveryId, messages) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = getDb().prepare(
    "INSERT INTO delivery_messages (delivery_id, seq, message, created_at) VALUES (?, ?, ?, ?)"
  );
  const tx = getDb().transaction((items) => {
    for (let i = 0; i < items.length; i++) {
      stmt.run(deliveryId, i, items[i], now);
    }
  });
  tx(messages);
}

function getUnsentMessages() {
  return getDb().prepare(
    "SELECT * FROM delivery_messages WHERE sent = 0 ORDER BY created_at ASC, seq ASC"
  ).all();
}

function markMessageSent(id) {
  getDb().prepare("UPDATE delivery_messages SET sent = 1, sent_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), id);
}

function isDeliveryFullySent(deliveryId) {
  const unsent = getDb().prepare(
    "SELECT COUNT(*) as c FROM delivery_messages WHERE delivery_id = ? AND sent = 0"
  ).get(deliveryId);
  return unsent.c === 0;
}

function getDeliveryMessages(deliveryId) {
  return getDb().prepare(
    "SELECT * FROM delivery_messages WHERE delivery_id = ? ORDER BY seq ASC"
  ).all(deliveryId);
}

function getUnsentDeliveriesWithoutMessages() {
  return getDb().prepare(`
    SELECT d.* FROM deliveries d
    WHERE d.sent = 0
      AND NOT EXISTS (SELECT 1 FROM delivery_messages dm WHERE dm.delivery_id = d.id)
    ORDER BY d.generated_at ASC
  `).all();
}
```

- [ ] **Step 3: Update `saveDelivery` to accept `storiesJson` parameter**

Replace the existing `saveDelivery`:

```js
function saveDelivery(id, type, content, storiesJson) {
  getDb().prepare(`
    INSERT OR REPLACE INTO deliveries (id, type, sent, generated_at, content, stories_json)
    VALUES (?, ?, 0, ?, ?, ?)
  `).run(id, type, Math.floor(Date.now() / 1000), content, storiesJson || null);
}
```

- [ ] **Step 4: Export the new functions**

Add to `module.exports`: `saveDeliveryMessages`, `getUnsentMessages`, `markMessageSent`, `isDeliveryFullySent`, `getDeliveryMessages`, `getUnsentDeliveriesWithoutMessages`.

- [ ] **Step 5: Run the app with `--test` to verify migration applies cleanly**

Run: `node src/index.js --test`
Expected: Migration 3 (delivery_messages) applied, then normal test output.

- [ ] **Step 6: Commit**

```bash
git add src/db.js
git commit -m "feat: add delivery_messages table for per-message send tracking"
```

---

### Task 2: Save stories alongside briefing delivery

**Files:**
- Modify: `src/intelligence.js:103-164` (generateBriefing function)

- [ ] **Step 1: Pass stories as JSON to `saveDelivery`**

In `generateBriefing`, change the `db.saveDelivery` call at line 162 from:

```js
db.saveDelivery(id, "briefing", content);
```

to:

```js
const storiesJson = JSON.stringify(stories.map((s) => ({
  id: s.id, title: s.title, url: s.url, points: s.points,
  type: s.type, relevance: s.relevance, summary: s.summary,
})));
db.saveDelivery(id, "briefing", content, storiesJson);
```

- [ ] **Step 2: Commit**

```bash
git add src/intelligence.js
git commit -m "feat: persist stories JSON with briefing deliveries"
```

---

### Task 3: Refactor delivery.js — message building + sending pipeline

This is the core change. Each `deliver*` function is split into: (1) build messages array, (2) save to `delivery_messages`, (3) attempt send. A single `flushUnsent` function handles all sending and retries.

**Files:**
- Modify: `src/delivery.js` (entire file restructure)

- [ ] **Step 1: Add the core send-and-track function**

Add after the existing `sendTelegram` function (after line 63):

```js
async function sendAndTrack(deliveryId, messages) {
  db.saveDeliveryMessages(deliveryId, messages);
  return await flushDeliveryMessages(deliveryId);
}

async function flushDeliveryMessages(deliveryId) {
  const rows = deliveryId
    ? db.getDeliveryMessages(deliveryId).filter((r) => !r.sent)
    : db.getUnsentMessages();

  for (const row of rows) {
    if (isQuietHours()) {
      db.enqueueQuiet(row.message);
      db.markMessageSent(row.id);
      continue;
    }
    const ok = await sendTelegram(row.message);
    if (!ok) return false; // stop on first failure, retry next cycle
    db.markMessageSent(row.id);
    if (db.isDeliveryFullySent(row.delivery_id)) {
      db.markDeliverySent(row.delivery_id);
    }
    await sleep(200);
  }
  return true;
}
```

- [ ] **Step 2: Refactor `deliverBriefing` — build messages, save, send**

Replace the entire `deliverBriefing` function (lines 100-179):

```js
async function deliverBriefing(id, content, storyCount, stories, fromLabel, toLabel) {
  const label = fromLabel && toLabel ? `${fromLabel} → ${toLabel}` : id;
  stories = stories || [];

  const mustRead = stories.slice(0, 5);
  const alsoRelevant = stories.slice(5);

  // Build markdown file (always, regardless of delivery mode)
  let md = `# Briefing — ${label}\n${storyCount} relevant stories\n\n${content}`;
  if (mustRead.length > 0) {
    md += "\n\n## Must read\n";
    for (const s of mustRead) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  if (alsoRelevant.length > 0) {
    md += "\n\n## Also relevant\n";
    for (const s of alsoRelevant) md += `- ${formatStoryLine(s)}\n  ${storyLink(s)}\n`;
  }
  writeToFile(`${id}.md`, md);

  const mode = config.delivery || "both";
  if (mode === "file") {
    db.markDeliverySent(id);
    return true;
  }

  // Build Telegram messages
  const messages = [];

  // Message 1+: Briefing text (chunked if needed)
  const header = `📋 <b>Briefing</b> — ${escape(label)}\n${storyCount} relevant stories\n\n`;
  const body = markdownToTelegramHtml(content);
  const fullMsg = header + body;

  if (fullMsg.length <= 4096) {
    messages.push(fullMsg);
  } else {
    const paragraphs = body.split("\n\n");
    let chunk = header;
    for (const p of paragraphs) {
      if (chunk.length + p.length + 2 > 3800) {
        messages.push(chunk);
        chunk = "";
      }
      chunk += (chunk ? "\n\n" : "") + p;
    }
    if (chunk.trim()) messages.push(chunk);
  }

  // Must read links
  if (mustRead.length > 0) {
    let linksMsg = `📌 <b>Must read</b> — ${escape(label)}`;
    for (const s of mustRead) {
      linksMsg += `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
    }
    messages.push(linksMsg);
  }

  // Also relevant (chunked)
  if (alsoRelevant.length > 0) {
    let chunk = `🔗 <b>Also relevant</b> — ${escape(label)}`;
    for (const s of alsoRelevant) {
      const line = `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
      if (chunk.length + line.length > 3500) {
        messages.push(chunk);
        chunk = `🔗 <b>Also relevant</b> (cont.)`;
      }
      chunk += line;
    }
    if (chunk.length > 40) messages.push(chunk);
  }

  return sendAndTrack(id, messages);
}
```

- [ ] **Step 3: Refactor `deliverWeekly` — same pattern**

Replace the `deliverWeekly` function:

```js
async function deliverWeekly(id, content, storyCount) {
  const week = id.replace("weekly-", "");
  writeToFile(`${id}.md`, `# Weekly Trend — ${week}\n${storyCount} stories analyzed\n\n${content}`);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📊 <b>Weekly Trend</b> — ${week}\n${storyCount} stories analyzed\n\n${markdownToTelegramHtml(content)}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 4: Refactor `deliverRising`**

Rising alerts don't currently go through the deliveries table. Save them there now.

Replace `deliverRising`:

```js
async function deliverRising(story) {
  const id = `rising-${story.id}`;
  const link = storyLink(story);
  const growth = `${story.prev_points} → ${story.points} pts (+${story.point_growth})`;
  const sum = story.summary ? `\n${story.summary}` : "";

  const content = `Rising: ${story.title}\n${growth}${sum}\n${link}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "rising", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📈 <b>Rising</b>\n\n<b>${escape(story.title)}</b>\n${growth}${sum ? "\n" + escape(sum) : ""}\n\n${link}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 5: Refactor `deliverOpportunity`**

Replace `deliverOpportunity`:

```js
async function deliverOpportunity(opp) {
  const id = `opportunity-${opp.comment_id}`;
  const story = db.getStory(opp.story_id) || {};
  const link = storyLink(story);
  const commentText = (opp.text || "")
    .replace(/<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<a\s+href="([^"]*)"[^>]*>[^<]*<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ").trim()
    .slice(0, 400);
  const extract = opp.extract || "";

  const content = `Opportunity in: ${opp.title}\n\n${opp.author}: "${commentText}"\n\nWhy: ${extract}\n\n${link}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "opportunity", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `💡 <b>Join this conversation</b>\n\n<b>${escape(opp.title)}</b> (${opp.story_points || 0} pts)\n\n${escape(opp.author)}: "${escape(commentText)}"\n\n${escape(extract)}\n\n${link}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 6: Refactor `deliverThreadReply`**

Replace `deliverThreadReply`:

```js
async function deliverThreadReply(thread) {
  const id = `reply-${thread.myComment.comment_id}-${Math.floor(Date.now() / 1000)}`;
  const hn = thread.hnUrl;
  const title = thread.storyTitle || "(unknown)";
  const replies = thread.replies.slice(0, 3);
  const replyText = replies.map((r) => {
    const t = (r.text || "").replace(/<[^>]+>/g, "").slice(0, 200);
    return `${r.author}: ${t}`;
  }).join("\n\n");

  const content = `Reply in: ${title}\n\n${replyText}\n\n${hn}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "reply", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `💬 <b>Reply to your comment</b>\n\nIn: <b>${escape(title)}</b>\n\n${escape(replyText)}\n\n${hn}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 7: Refactor `deliverStarChange`**

Replace `deliverStarChange`:

```js
async function deliverStarChange(repo) {
  const id = `stars-${repo.full_name.replace("/", "-")}-${Math.floor(Date.now() / 1000)}`;
  const content = `Your repo gained stars: ${repo.full_name}\n${repo.prev_stars} → ${repo.stars} (+${repo.star_growth})\nhttps://github.com/${repo.full_name}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "stars", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `⭐ <b>Stars on your repo</b>\n\n<b>${escape(repo.full_name)}</b>\n${repo.prev_stars} → ${repo.stars} (+${repo.star_growth})\n\nhttps://github.com/${repo.full_name}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 8: Refactor `deliverRelease`**

Replace `deliverRelease`:

```js
async function deliverRelease(release) {
  const id = `release-${release.full_name.replace("/", "-")}-${release.tag_name}`;
  const body = (release.body || "").slice(0, 300);
  const content = `New release: ${release.full_name} ${release.tag_name}\n${release.name}\n\n${body}\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`;
  writeToFile(`${id}.md`, content);
  db.saveDelivery(id, "release", content);

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `📦 <b>New release</b>\n\n<b>${escape(release.full_name)}</b> ${escape(release.tag_name)}\n${escape(release.name)}\n\n${escape(body)}\n\nhttps://github.com/${release.full_name}/releases/tag/${release.tag_name}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 9: Refactor `deliverCompetitive`**

Replace `deliverCompetitive`:

```js
async function deliverCompetitive(content, storyId) {
  const id = `competitive-${storyId}`;
  writeToFile(`${id}.md`, `# Competitor\n\n${content}`);
  // competitive deliveries are already saved by intelligence.js

  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(id); return true; }

  const text = `🔍 <b>Competitor</b>\n\n${markdownToTelegramHtml(content)}`;
  return sendAndTrack(id, [text]);
}
```

- [ ] **Step 10: Rewrite `flushUnsent`**

Replace the old `flushUnsent`:

```js
async function flushUnsent() {
  // First: rebuild messages for deliveries that were saved but never got messages
  // (e.g., app crashed between generateBriefing and deliverBriefing)
  const orphaned = db.getUnsentDeliveriesWithoutMessages();
  for (const d of orphaned) {
    rebuildDeliveryMessages(d);
  }

  // Then: send all unsent messages in order
  const ok = await flushDeliveryMessages(null);
  return ok;
}

function rebuildDeliveryMessages(delivery) {
  const mode = config.delivery || "both";
  if (mode === "file") { db.markDeliverySent(delivery.id); return; }

  if (delivery.type === "briefing") {
    const stories = delivery.stories_json ? JSON.parse(delivery.stories_json) : [];
    const storyCount = stories.length;
    const label = delivery.id.replace("briefing-", "");

    const messages = [];
    const header = `📋 <b>Briefing</b> — ${escape(label)}\n${storyCount} relevant stories\n\n`;
    const body = markdownToTelegramHtml(delivery.content);
    const fullMsg = header + body;

    if (fullMsg.length <= 4096) {
      messages.push(fullMsg);
    } else {
      const paragraphs = body.split("\n\n");
      let chunk = header;
      for (const p of paragraphs) {
        if (chunk.length + p.length + 2 > 3800) {
          messages.push(chunk);
          chunk = "";
        }
        chunk += (chunk ? "\n\n" : "") + p;
      }
      if (chunk.trim()) messages.push(chunk);
    }

    const mustRead = stories.slice(0, 5);
    const alsoRelevant = stories.slice(5);

    if (mustRead.length > 0) {
      let linksMsg = `📌 <b>Must read</b> — ${escape(label)}`;
      for (const s of mustRead) {
        linksMsg += `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
      }
      messages.push(linksMsg);
    }

    if (alsoRelevant.length > 0) {
      let chunk = `🔗 <b>Also relevant</b> — ${escape(label)}`;
      for (const s of alsoRelevant) {
        const line = `\n\n${escape(formatStoryLine(s))}\n${storyLink(s)}`;
        if (chunk.length + line.length > 3500) {
          messages.push(chunk);
          chunk = `🔗 <b>Also relevant</b> (cont.)`;
        }
        chunk += line;
      }
      if (chunk.length > 40) messages.push(chunk);
    }

    db.saveDeliveryMessages(delivery.id, messages);
  } else {
    // For all other types, content was already formatted as Telegram HTML
    // Re-wrap with appropriate emoji header
    db.saveDeliveryMessages(delivery.id, [delivery.content]);
  }
}
```

- [ ] **Step 11: Remove `sendTelegramDirect` and old `flushQuietQueue` approach**

The `sendTelegramDirect` function is no longer needed since quiet hours are now handled inside `flushDeliveryMessages`. Remove `sendTelegramDirect` (lines 332-343).

Update `flushQuietQueue` — it still handles the legacy `quiet_queue` table, but now quiet hours are also checked in `flushDeliveryMessages`. Keep `flushQuietQueue` as-is for draining any remaining quiet_queue entries, but it's no longer the primary mechanism.

- [ ] **Step 12: Update module.exports**

Update the exports to include new functions and remove old ones:

```js
module.exports = {
  deliverBriefing, deliverWeekly, deliverRising, deliverOpportunity, deliverThreadReply, deliverStarChange, deliverRelease, deliverCompetitive,
  flushUnsent, flushQuietQueue, isQuietHours, writeToFile,
};
```

(Same exports — the interface doesn't change, only internals.)

- [ ] **Step 13: Commit**

```bash
git add src/delivery.js
git commit -m "feat: track individual Telegram messages in DB, retry on failure"
```

---

### Task 4: Update `index.js` — reset cleanup + remove redundant flush

**Files:**
- Modify: `src/index.js:549-554` (--reset handler)

- [ ] **Step 1: Add `delivery_messages` to `--reset` cleanup**

Change line 551 from:

```js
db.getDb().exec("DELETE FROM story_analysis; DELETE FROM comment_analysis; DELETE FROM work_queue; DELETE FROM deliveries; DELETE FROM people; DELETE FROM github_repo_analysis;");
```

to:

```js
db.getDb().exec("DELETE FROM story_analysis; DELETE FROM comment_analysis; DELETE FROM work_queue; DELETE FROM deliveries; DELETE FROM delivery_messages; DELETE FROM people; DELETE FROM github_repo_analysis;");
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "fix: include delivery_messages in --reset cleanup"
```

---

### Task 5: Bump version + changelog

**Files:**
- Modify: `package.json:2` (version)
- Modify: `CHANGELOG.md` (new section)

- [ ] **Step 1: Bump version in package.json**

Change `"version": "1.0.0"` to `"version": "1.1.0"`.

- [ ] **Step 2: Add changelog entry**

Add after `# Changelog`:

```markdown
## 1.1.0

Reliable message delivery.

- Every Telegram message is now saved to the database before sending
- Failed sends are retried automatically on the next cycle, in order
- Briefing story links are persisted alongside AI content — retries include full link lists
- All delivery types (briefing, weekly, rising, opportunity, reply, stars, release, competitive) now track individual message delivery status
- Parent delivery is only marked as "sent" when all its messages have been delivered
```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump to 1.1.0 — reliable message delivery"
```

---

### Task 6: Manual verification

- [ ] **Step 1: Run `--test` to verify migration and app starts**

Run: `node src/index.js --test`
Expected: "Migration 3 (delivery_messages) applied." then all connectivity checks.

- [ ] **Step 2: Run `--once` to verify a full cycle works end-to-end**

Run: `node src/index.js --once`
Expected: Collect → Analyze → Intelligence cycle completes. Any generated deliveries should produce rows in `delivery_messages`. Check with:

```bash
sqlite3 data/db "SELECT id, delivery_id, seq, sent FROM delivery_messages ORDER BY id DESC LIMIT 20;"
```

- [ ] **Step 3: Verify retry behavior — simulate Telegram failure**

Temporarily break the Telegram token in `secrets.json`, run `--once`. Check that:
1. `delivery_messages` rows are created with `sent=0`
2. `deliveries` rows have `sent=0`

Fix the token, run `--once` again. Check that:
1. Previously unsent messages are now `sent=1`
2. Parent deliveries are `sent=1`

- [ ] **Step 4: Verify `--status` shows correct unsent count**

Run: `node src/index.js --status`
The "Unsent deliveries" count should reflect actual state.
