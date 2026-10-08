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


