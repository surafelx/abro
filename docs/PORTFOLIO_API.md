# Portfolio API (what Abro calls)

Any portfolio site can let Abro add entries and publish a resume by exposing these routes. Each person sets their portfolio's base URL and key in Abro's Setup.

- **Base URL**: e.g. `https://my-site.vercel.app/api/abro`
- **Auth**: every request sends `Authorization: Bearer <key>`. Reject anything else with 401.
- **Format**: JSON in, JSON out. Errors are `{ "error": "message" }` with a 4xx/5xx status.

## Entries

An entry is something worth showing: a project, a post, or a skill.

```json
{
  "id": "abro-ticket-triage-agent",
  "kind": "project",
  "title": "Ticket triage agent",
  "summary": "One sentence for cards and the resume.",
  "details": "A few short paragraphs or bullet lines (Markdown).",
  "stack": ["TypeScript", "Next.js", "Gemini"],
  "links": { "live": "https://…", "code": "https://github.com/…", "post": "https://…" },
  "date": "2026-10",
  "visible": false
}
```

`kind` is one of `project`, `post`, `skill`. Abro always creates entries with `visible: false` (a draft). The site must not show hidden entries.

| Route | Does |
|---|---|
| `GET /entries` | Entries created by Abro: `{ "entries": [Entry] }` |
| `PUT /entries/:id` | Create or replace that entry. Returns `{ "entry": Entry, "url": "https://… (optional, where it shows)" }` |
| `PATCH /entries/:id` | Change some fields, e.g. `{ "visible": true }` to publish. Returns `{ "entry": Entry }` |
| `DELETE /entries/:id` | Remove it. Returns `{ "ok": true }` |

## Profile (optional)

`GET /profile` returns what the site already knows, so Abro can start a resume from it:

```json
{
  "name": "", "headline": "", "location": "", "email": "", "website": "",
  "links": [{ "label": "GitHub", "url": "https://…" }],
  "summary": "",
  "experience": [{ "title": "", "org": "", "when": "", "summary": "", "bullets": [""] }],
  "education": [{ "title": "", "org": "", "when": "" }],
  "skills": [{ "group": "", "items": [""] }]
}
```

## Resume

`PUT /resume` with `{ "pdf": "<base64>", "docx": "<base64>", "updatedAt": "ISO date" }` publishes the files on the site. Returns `{ "pdfUrl": "…", "docxUrl": "…" }`.
