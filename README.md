# AI Hallucination Demo

A mobile-friendly web app for a five-minute talk. Type one question, send the **same prompt and settings** to two live models through OpenRouter, read both answers side by side, then run an **evidence-based claim check** (Supported / Contradicted / Unverified, with source links).

- `openai/gpt-4o-mini` (OpenAI GPT-4o mini)
- `google/gemini-2.5-flash` (Google Gemini 2.5 Flash)

**Honest framing built into the app:** both models can make mistakes; one demonstration cannot show which model hallucinates more; and the claim checker can also be wrong. The app never labels either model as "the hallucinating one."

No npm packages are needed. It only requires **Node.js 18 or newer**.

## Run it locally

1. Install Node.js 18+ from https://nodejs.org (check with `node -v`).
2. Get an OpenRouter key at https://openrouter.ai/keys and add a few dollars of credit.
3. In this folder, create your `.env` file:
   - Mac / Linux: `cp .env.example .env`
   - Windows (Command Prompt): `copy .env.example .env`
   - Windows (PowerShell): `Copy-Item .env.example .env`
4. Open `.env` in a text editor and replace `put_your_key_here` with your key:
   `OPENROUTER_API_KEY=sk-or-...your-real-key...`
5. Start the server: `node server.js` (or `npm start`)
6. Open http://localhost:3000. To test on your phone on the same Wi-Fi, use `http://YOUR-COMPUTER-IP:3000`.

If you see a blue "Setup needed" box, the key is missing or still the placeholder. Edit `.env` and restart.

Optional self-test (no key or internet needed; uses a fake OpenRouter): `npm test`

## Presenting (five-minute flow)

1. **Ask:** tap an example chip or type your own. Pick something specific and checkable: a date, name, number, book, or paper. Obscure facts are more likely to expose mistakes, but results vary from run to run.
2. **Compare:** both answers appear in separate panels. Read a few lines aloud.
3. **Inspect:** tap **Check key claims** and open the source links. Say clearly that the checker is also an AI and can be wrong.
4. **Close with the limits:** one question proves nothing about which model is better overall. Check important facts yourself.

Tip: try your question once before the talk so you know it works, and have a backup question ready in case a model answers correctly (that is a fine outcome and a good teaching moment).

## How the comparison stays fair

- Identical user question, identical system instruction, same `temperature` (0.3) and `max_tokens` (400), sent in parallel.
- The checker sees the answers labelled only "A" and "B", with no model names.
- The checker defaults to `perplexity/sonar`, a search-grounded model from a third provider, so neither compared model grades itself. Change it with `CHECKER_MODEL` in `.env`. Any other model gets OpenRouter's web-search plugin attached automatically.
- Only source links the checker actually retrieved are shown. A Supported or Contradicted verdict with no verifiable link is automatically downgraded to Unverified.

## Security and public-demo protections

- The OpenRouter key is read only by the server (`server.js`) from `.env` or host environment variables. The browser never sees it. `.env` is in `.gitignore`, and the ZIP contains only `.env.example`.
- Question length capped at 300 characters; request bodies capped at 4 KB.
- Per-IP rate limits (default 6 compares and 6 checks per 10 minutes) and a global daily cap (default 300 calls) so a public link cannot drain your credits. Adjust in `.env`.
- Optional `ACCESS_CODE`: visitors must type it in the app. Recommended for a public URL; share it only with your audience.
- The checker uses a short-lived server-side copy of the answers (by random ID, 30 minutes), so visitors cannot send arbitrary text to the checker.
- Model output is rendered as plain text (no HTML injection), strict Content-Security-Policy, no CORS, request timeouts, and no stack traces or upstream error details sent to the browser.
- **Also set a spending limit on your OpenRouter key** in the OpenRouter dashboard. This is the strongest protection.

## Deploy to a public URL (for a QR code)

You need a host that runs Node. Your key is entered in the host's dashboard as an environment variable, never in the code.

### Option A: Render (simple, free tier available)
1. Put this folder in a **private** GitHub repo (`.env` is ignored, so your key stays out).
2. In Render: New → Web Service → connect the repo. Runtime Node, build command blank or `echo ok`, start command `node server.js`. (`render.yaml` is included for one-click Blueprint setup.)
3. Under Environment, add `OPENROUTER_API_KEY` (your key), `TRUST_PROXY=true`, and ideally `ACCESS_CODE`.
4. Deploy. You get a URL like `https://your-app.onrender.com`. Free instances sleep when idle, so open the URL a minute before you present.

### Option B: Railway or Fly.io
Create a project from the repo, set the same three variables, and use start command `node server.js`. The app listens on the `PORT` the host provides.

### Check it before you share it
- Open the public URL on your phone (mobile data, not Wi-Fi) and run one full question and check.
- Visit `/api/health`; it should show `{"ok":true}`.
- Make sure the page is `https://`.

### Make the QR code
Paste your public URL into any QR generator (for example https://www.qrcode-monkey.com or `qrencode -o qr.png "https://your-app.onrender.com"`). Test-scan it with a phone, and put a copy of the URL on your slide. If you use an access code, show it on the slide too.

## Project layout

```
server.js          Node server: API proxy, limits, claim checker (no dependencies)
public/            index.html, styles.css, app.js (no key, no build step)
test/smoke.js      Offline self-test with a fake OpenRouter
.env.example       Template; copy to .env and add your key
render.yaml        Optional Render blueprint
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Setup needed" box | `.env` missing or key still `put_your_key_here`. Edit and restart. |
| "key was rejected" | Key is wrong, revoked, or has extra spaces or quotes. |
| "out of credits" | Add credit at openrouter.ai. |
| Check says "no verifiable source link" | Expected sometimes. The checker found no retrievable page, so the claim stays Unverified. |
| Model not found | A model slug may have been renamed; check openrouter.ai/models and update `MODELS` in `server.js`. |
