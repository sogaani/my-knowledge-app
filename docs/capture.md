# Captures: AI research into the KB

One API for everything captured outside the KB — a Gemini / Claude / ChatGPT / NotebookLM / Perplexity conversation, a
Claude Code research summary, a link or text shared from the phone — with one status that every client shows.

```
Chrome extension (obsidian-AI-exporter fork, output "my-knowledge") ─┐  browser login (Access cookie)
phone share sheet → WebUI /capture (PWA share_target)                ─┤  browser login
kb capture (save-research skill in Claude Code)                       ─┘  kb-capture service token
        │ POST /api/captures
        ▼
API: captures row (key, version, hash) + inbox item capture-<platform>-<slug>-<hash>.md + ingest job
        │ worker: stage → ingest skill → commit → done { result.items: [{ name, bronze, notes, processed }] }
        ▼
API settles the capture: done (notes) / stored (Bronze, no note) / failed
        ▲
GET /api/captures/:id · GET /api/captures?key=<platform>:<conversation id> · GET /api/captures (list)
```

## Request
`POST /api/captures` (JSON):

| field | |
|---|---|
| `client` | `chrome` / `claude-code` / `share` / `cli` |
| `platform` | `gemini` / `claude` / `chatgpt` / `notebooklm` / `perplexity` / `claude-code` / `web` |
| `conversation_id` | the conversation / session id. With `platform` it is the **key**; without it the URL (else the body) is |
| `url`, `title`, `markdown` | the page, a title, the whole conversation as Markdown (≤ 8 MiB). `markdown` or `url` is required |
| `area` | `work` / `personal`; unset = the ingest decides |
| `note`, `account`, `captured_at` | why it was saved; the platform account (`work`); when |

Answer: `{ capture, duplicate, replaced? }`. Duplicates are stopped at three points:

1. **Same content** — the same key whose newest version has the same `hash` → `duplicate: true`, nothing queued (unless
   that version failed). The hash is over the body **without a leading YAML frontmatter block**, with line endings and
   trailing spaces normalised: the extension renders an Obsidian note whose `created` / `modified` are the sync time, so
   hashing the raw text would make every click "new". A capture without a body hashes its URL.
2. **Changed while waiting** — the newest version's ingest job is still `queued` (the worker has not claimed it) → its
   content is replaced in place (`replaced: true`): same id, version and job, one copy staged.
3. **Changed after the worker took it** → the next `version`. `previous_notes` is filled when the worker fetches the
   inbox item (`GET /api/worker/inbox/:id` renders the file from `captures.input`), so a version queued while the
   previous one was being ingested still points at the notes that one made, and the ingest updates them.

Below the API, Bronze drops a file whose bytes it already holds (`ingestFile`'s SHA-256 check), which covers repeated
`kb capture` runs that fell back to the local inbox.

## What the ingest gets
The inbox file is YAML frontmatter (`capture_id`, `capture_key`, `version`, `client`, `platform`, `title`, `url`,
`conversation_id`, `account`, `area`, `note`, `captured_at`, `content_hash`, `previous_notes`) and the body as sent.
`previous_notes` lists the notes the newest settled version went to, so a re-sync updates them instead of starting new
ones. The routing rule is the `capture-*.md` row of the data repo's `ingest` skill.

## Status
`queued` / `running` (the ingest job) → `done` (Bronze `processed_to` set: `notes` lists the Silver notes, empty when the
ingest reviewed it with nothing to reflect) / `stored` (in Bronze, not processed) / `failed` (job failed, or the item
never left the inbox). The worker finds each staged item's Bronze entry by `meta.source` (the file name) and reports it in
the `done` body (`result.items`); the API settles the job's captures from it (`settleCaptures`).

## Clients
- **Chrome extension**: `~/git/obsidian-AI-exporter`, branch `my-knowledge` (a local clone of
  sho7650/obsidian-AI-exporter, MIT). Output "my-knowledge"; the sync badge shows the capture status and links the notes.
- **`kb capture`** (`apps/cli`): `kb capture --title … --id … --area … < body.md`, `kb capture status <id> [--wait s]`.
  Credentials in the data repo's `900_system/config.local.toml` `[capture]` (or env `KB_API_URL` /
  `KB_CAPTURE_CLIENT_ID` / `KB_CAPTURE_CLIENT_SECRET`); without them it writes the file into the local `000_inbox/`.
  The data repo's `save-research` skill (linked into `~/.claude/skills`) writes the summary and calls it.
- **Phone**: install the WebUI as a PWA; it registers as a share target (`/capture?title&text&url`). The page also lists
  every capture with its status.
