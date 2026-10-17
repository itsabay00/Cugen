# Resolve — Customer Service Advisor Assistant

A workspace for customer-service advisors: pull in a customer case, let the AI read it and draft a reply from your knowledge base, refine the draft in chat, then send it to the customer by email, WhatsApp or text message — and track every case by status.

Built to match the Figma file: Lexend throughout, Phosphor icons, a 280px sidebar, a white middle section with 200px cards, and a 400px AI Assistant panel that can be dragged wider or narrower. On a phone it shows one screen at a time. Status messages use the semantic palette: error `#FF4B49`/`#FFEDED`, warning `#FEBE00`/`#FFF8E5`, success `#01C15A`/`#E6F9EF`, info `#219BFF`/`#E9F5FF`.

## What an advisor does

1. **Get next case** — the app looks for a case for about 5 seconds, like a live queue (the cases themselves are simulated for now, see "Known limits"), then opens it. The assistant starts reading it straight away: it picks a category and urgency, writes a short note for the advisor, and drafts a reply grounded in the knowledge base.
2. **Review** — the customer's message and details (order number, item/SKU, tracking number and link, attached photos) sit at the top of the AI panel. The AI's note is shown separately from the **Draft reply**, which is the only thing Copy and Send use.
3. **Refine** — ask the assistant anything about the case ("More empathetic", "What policy applies here?", or your own request). Attach a photo with the paperclip and the AI actually looks at it.
4. **Send** — *Send to customer* opens the channel you pick — **Email**, **WhatsApp** or **Text message** — with the reply filled in. The choice is remembered, and you can change it at any time. Afterwards, one tap marks the case *Waiting for Customer*.
5. **Next** — as soon as you finish a new case (send it on, transfer it or close it) the app starts looking for your next one automatically. A notice at the top shows the search and has a **Cancel** button; the behaviour can be switched off in **Settings → Case queue**.

## What's in it

- **Case details and photos.** "Paste a specific case manually" takes the customer's message plus order number, SKU, tracking number, tracking link and up to 3 photos. All of it reaches the AI on every turn.
- **Knowledge base (KB).** Add entries one at a time or **import a file** (`.txt`, `.md`, `.csv`, `.json`). Relevant entries are matched to each case and given to the AI, and the reply says which ones it drew on ("From your knowledge base: …").
- **Statuses.** New, Transferred, Waiting for Customer, Closed — changeable from the case, filterable from the sidebar. History lists everything you've handled.
- **Settings → AI connection.** Shows which provider is configured and has a **Test connection** button that makes one real call and reports who answered — or exactly why nothing could.
- **Specific errors, always.** Out of credit, wrong key, model not available, rate limited, provider down, too slow, no internet, server unreachable, host blocking the request… each has its own message and, where it helps, a shortcut to Settings.

## How it's built

- **Frontend:** React 18 + Vite, Tailwind via CDN, Lexend from Google Fonts, `@phosphor-icons/react`. Code lives in `src/` — `components/` (Sidebar, GetStarted, CaseListView, HistoryView, KnowledgeBaseView, SettingsView, ChatPanel, shared UI), `lib/` (API client, image shrinking, storage, KB matching, design tokens, seed cases) and `App.jsx` (the shell, including the drag-to-resize logic).
- **Backend:** two small Vercel serverless functions in `api/`.
  - `claude.js` talks to whichever AI provider is configured (next section). The frontend sends one provider-neutral message format; the function translates it for Anthropic or for OpenAI-compatible APIs, including images. Keys never reach the browser and are scrubbed from every response.
  - `send-email.js` is an *optional* direct-send path (see "Sending to customers").
  - `vercel.json` gives the functions up to 60 seconds, which slower free models sometimes need.
- **Storage:** the browser's `localStorage` — each device keeps its own cases and knowledge base. The app shows a warning if storage fills up instead of silently losing data.
- **Photos** are shrunk in the browser before upload (so a large phone picture can't exceed the server's ~4 MB request limit), and re-attached to the case on every AI turn.

## Connecting an AI provider

In Vercel → your project → Settings → Environment Variables, add **at least one** of these, then **redeploy** (variables only apply to the next deployment):

| Variable | Provider | Cost |
| --- | --- | --- |
| `NVIDIA_API_KEY` | NVIDIA Build — [build.nvidia.com](https://build.nvidia.com) (open models such as Llama 3.3 70B) | Free tier |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | Paid — needs credit |
| `OPENAI_API_KEY` | OpenAI | Paid — needs credit |
| `AI_API_KEY` | Anything else. `gsk_…` (Groq), `sk-or-…` (OpenRouter), `AIza…` (Gemini, also set `AI_MODEL`) and `xai-…` (xAI) keys are recognised automatically. For any other provider also set `AI_BASE_URL` (e.g. `https://api.together.xyz/v1`) and `AI_MODEL`. | Depends |

**How "any provider" works.** Anthropic's format is built in, and so is the OpenAI-style `/chat/completions` format that almost every other provider offers (NVIDIA, Groq, OpenRouter, Together, Mistral, DeepSeek, Gemini's compatibility endpoint, Ollama, …). If a provider offers neither, it would need its own adapter in `api/claude.js`.

If several keys are set they're tried in the order Anthropic → OpenAI → NVIDIA → `AI_API_KEY`, and when one can't answer (no credit, bad key, overloaded) the next one takes over. `AI_PROVIDER=nvidia` (or `anthropic`, `openai`, …) puts that provider first.

Optional settings: `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `NVIDIA_MODEL`, `AI_MODEL` (defaults `claude-sonnet-5-5`, `gpt-4o`, `meta/llama-3.3-70b-instruct`); `NVIDIA_VISION_MODEL` / `AI_VISION_MODEL` (used when a case has a photo — NVIDIA defaults to `meta/llama-3.2-90b-vision-instruct`, because the default Llama model can't see images); `*_BASE_URL` to point at a different endpoint; `AI_PROVIDER_NAME` for the label shown in messages; `AI_TOTAL_TIMEOUT_MS` (default 52000).

Reasoning models that print their thinking (`<think>…</think>`) are handled — the thinking is stripped before anything is shown.

### Checking that it works

- **In the app:** Settings → **Test connection**.
- **In the browser:** open `https://YOUR-SITE.vercel.app/api/claude` to see which providers are set up (keys are never shown), or add `?test=1` to make one real test call.

What the error codes mean:

| Code | Meaning | Fix |
| --- | --- | --- |
| `missing_key` / `missing_config` | No provider key (or no endpoint/model for a custom provider) | Add it in Vercel, redeploy |
| `invalid_key` | The provider rejected the key | Re-copy the key into Vercel, redeploy |
| `insufficient_credits` | The account is out of credit/quota | Add credit, or use a free provider |
| `model_not_found` / `endpoint_not_found` / `permission_denied` | The key can't use that model/endpoint | Set the `*_MODEL` / `*_BASE_URL` variable to one it can use |
| `region_blocked` | The provider isn't available from the server's region | Use another provider |
| `rate_limited` / `overloaded` / `server_error` | The provider is busy or down | Wait and retry (it already retried once) |
| `timeout` | The provider took too long | Retry; try a faster model |
| `upstream_unreachable` | Couldn't connect to the provider | Check the provider's status page |
| `request_too_large` / `context_too_long` | Photo or conversation too big | Smaller photo, or start a new chat |
| `content_blocked` | The provider's safety filter declined the request | Rephrase |
| `all_providers_failed` | Every configured provider failed | The message lists each reason |

Problems that happen *before* the request reaches the function are explained too: the browser is offline, the server can't be reached, `/api` isn't deployed (HTTP 404), Vercel **Deployment Protection** is switched on and blocking the request (HTTP 401/403 — turn it off under Settings → Deployment Protection, or test on the production domain), or the request was too big for the host (HTTP 413).

## Sending to customers

Free by default: *Open in email app* builds a `mailto:` link, *Open WhatsApp* a `wa.me` link and *Open messages* an `sms:` link — each opens the app on the advisor's own device with the reply pre-filled. Nothing to set up and no account needed. WhatsApp needs the customer's number with the country code (e.g. `+233 24 123 4567`).

**Optional:** to have the platform send email itself, set `RESEND_API_KEY` (and `EMAIL_FROM`) in Vercel. A *Send directly* button then appears next to the channel buttons; until then it stays hidden. Note: Resend's shared test address can only deliver to the email that signed up for the account until a domain is verified at resend.com/domains.

## Run it locally

```bash
npm install
cp .env.example .env.local   # paste at least one key into .env.local
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

Plain `vite dev` does **not** run the `/api` functions, so the AI features won't work with `npm run dev` alone. To test them locally, install the Vercel CLI once (`npm i -g vercel`) and run `vercel dev` instead.

`npm test` runs the checks for the reply-draft handling and the AI answer parser (plain Node, nothing to install).

## Deploy to Vercel

1. Push this code to GitHub (next section).
2. Go to [vercel.com/new](https://vercel.com/new) and import the `Customer-Service-Resolver` repo.
3. Vercel detects a Vite project — leave the build settings on default.
4. Before clicking Deploy, add at least one AI key (see "Connecting an AI provider" — `NVIDIA_API_KEY` is the free one).
5. Click **Deploy**. You get a live `*.vercel.app` link to share with testers.
6. Every later `git push` to `main` redeploys automatically. After changing an environment variable, redeploy so it takes effect.

## Pushing this folder to GitHub

```bash
git remote add origin https://github.com/itsabay00/Customer-Service-Resolver.git
git branch -M main
git add -A
git commit -m "Resolve: CS advisor assistant"
git push -u origin main
```

(Or copy the files into the folder GitHub Desktop is tracking, then commit and push from there.)

## Known limits (first version)

- **Not shared across a team yet.** Cases and the knowledge base live in each browser's `localStorage` (roughly 5 MB per browser; the app warns when it's full). A shared version needs a small real database (Vercel KV, Supabase…) — worth doing once the concept is validated with real users.
- **Cases are simulated.** "Get next case" takes the next one from a fixed set of six examples (`src/lib/seedCases.js`) and cycles, after a 5-second search that stands in for a live queue (`SEARCH_MS` in `src/App.jsx`). A real channel (connected inbox, contact form) is a separate, bigger task. The "preparing" time you see afterwards is the AI's real response time.
- **The AI endpoint has no login.** Anyone who knows your site's address could use your AI quota. Fine for a small private test; add sign-in or rate limiting before sharing widely.
- **Draft detection relies on the AI following a formatting rule** (it fences the customer-ready text; the app adds a reminder to every message). If a model ignores it, its reply still shows as normal text, but *Copy draft* and *Send to customer* fall back to the last properly marked draft — select the text in the chat to copy a revision by hand.
- **Real API usage.** Every case pulled and every chat message is a real API call — billed on paid providers, counted against the free tier on NVIDIA.
- **Customer data.** Case text and attached photos are sent to whichever AI provider answers. Keep that in mind when testing with real customer messages.
- **Knowledge-base import** reads text, Markdown, CSV and JSON (up to 500 KB, 300 entries). PDFs and Word files aren't read yet — save them as text first.
- **@ mentions are still a placeholder.** Photo attachments work; the @ button doesn't yet.
- **Warning banners use dark text** on the pale yellow background, because `#FEBE00` text on `#FFF8E5` is too faint to read. The yellow is kept for the icon and the background.
- **"Acme" branding and the logo square are placeholders**, matching the Figma file — swap in your real name and mark whenever you're ready.
