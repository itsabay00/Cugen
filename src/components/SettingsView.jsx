import { useEffect, useState } from "react";
import { CircleNotch, Plugs, EnvelopeSimple } from "@phosphor-icons/react";
import { colors } from "../lib/colors.js";
import { getAiStatus, testAiConnection, getEmailStatus } from "../lib/api.js";
import { Card, OutlinePill, PrimaryButton, Banner } from "./ui.jsx";

function Lines({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {items.map((line, i) => (
        <li key={i} className="text-xs break-words" style={{ color: colors.ink }}>
          {line}
        </li>
      ))}
    </ul>
  );
}

const seconds = (ms) => (ms >= 100 ? `${(ms / 1000).toFixed(1)}s` : "under a second");

function AiConnectionCard() {
  const [status, setStatus] = useState(null); // the server's "what's configured" answer
  const [statusError, setStatusError] = useState(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState(null); // the server's answer to a real test call
  const [resultError, setResultError] = useState(null); // couldn't even reach the server

  function loadStatus() {
    setStatus(null);
    setStatusError(null);
    getAiStatus()
      .then(setStatus)
      .catch((err) => setStatusError(err));
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function runTest() {
    if (testing) return;
    setTesting(true);
    setResult(null);
    setResultError(null);
    try {
      setResult(await testAiConnection());
    } catch (err) {
      setResultError(err);
    } finally {
      setTesting(false);
    }
  }

  const configured = (status && status.configured) || [];
  const noKey = status && status.code === "missing_key";

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium" style={{ color: colors.black }}>AI connection</h3>
          <p className="text-sm mt-1" style={{ color: colors.gray }}>
            The assistant works with any AI provider. The key lives on your server (Vercel), never in the browser.
          </p>
        </div>
        <PrimaryButton onClick={runTest} disabled={testing || Boolean(statusError)} className="shrink-0" data-testid="ai-test-button">
          {testing ? (
            <>
              <CircleNotch className="w-4 h-4 animate-spin" /> Testing…
            </>
          ) : (
            <>
              <Plugs className="w-4 h-4" /> Test connection
            </>
          )}
        </PrimaryButton>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {!status && !statusError && (
          <p className="text-sm flex items-center gap-2" style={{ color: colors.gray }}>
            <CircleNotch className="w-4 h-4 animate-spin" /> Checking which provider is set up…
          </p>
        )}

        {statusError && <Banner kind="error" message={statusError.message} testId="ai-status-error" />}

        {noKey && <Banner kind="warning" message={status.error} testId="ai-no-key" />}

        {configured.length > 0 && (
          <div className="flex flex-col gap-2" data-testid="ai-providers">
            {configured.length > 1 && (
              <p className="text-xs" style={{ color: colors.gray }}>
                Tried in this order — if one can't answer, the next one takes over.
              </p>
            )}
            {configured.map((p, i) => (
              <div key={`${p.provider}-${i}`} className="flex flex-col gap-1.5 rounded-lg p-3" style={{ backgroundColor: colors.bg }}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-normal truncate" style={{ color: colors.black }}>{p.provider}</p>
                    <p className="text-xs truncate" style={{ color: colors.gray }}>
                      {p.model ? p.model : "no model chosen"}
                      {p.imageModel ? ` · images: ${p.imageModel}` : ""}
                    </p>
                  </div>
                  <OutlinePill label={p.key} />
                </div>
                {p.problem && <Banner kind="warning" message={p.problem} />}
              </div>
            ))}
          </div>
        )}

        {testing && <Banner kind="info" message="Asking the AI to say OK… a free key can take up to a minute to answer." testId="ai-testing" />}

        {resultError && <Banner kind="error" message={resultError.message} testId="ai-test-error" />}

        {result && result.ok && (
          <>
            <Banner kind="success" message={`Connected — ${result.provider} answered in ${seconds(result.ms)} using ${result.model}.`} testId="ai-test-ok" />
            {result.skipped && result.skipped.length > 0 && (
              <Banner kind="warning" message="A backup provider answered because an earlier one couldn't. Fix or remove that key so it stops failing:" testId="ai-test-skipped">
                <Lines items={result.skipped.map((s) => `${s.provider}: ${s.message}`)} />
              </Banner>
            )}
          </>
        )}

        {result && !result.ok && (
          <Banner kind="error" message={result.error} testId="ai-test-failed">
            {result.attempts && result.attempts.length > 1 && <Lines items={result.attempts.map((a) => `${a.provider}${a.model ? ` (${a.model})` : ""}: ${a.message}`)} />}
          </Banner>
        )}
      </div>

      <details className="mt-4 group">
        <summary className="text-sm font-medium cursor-pointer select-none" style={{ color: colors.ink }}>
          How to add or change a key
        </summary>
        <ol className="mt-3 flex flex-col gap-2 pl-5 list-decimal text-sm" style={{ color: colors.sectionGray }}>
          <li>
            Get a key from any AI provider. Free options exist — for example NVIDIA Build (build.nvidia.com), Groq (console.groq.com) or Google AI Studio (aistudio.google.com).
          </li>
          <li>
            In Vercel, open your project → Settings → Environment Variables and add the key as <b>NVIDIA_API_KEY</b>, <b>ANTHROPIC_API_KEY</b> or <b>OPENAI_API_KEY</b> — or as <b>AI_API_KEY</b> for any other provider. Tick Production.
          </li>
          <li>
            Keys from Groq (gsk_…), OpenRouter (sk-or-…), Gemini (AIza…) and xAI (xai-…) are recognised automatically. For any other provider that uses the OpenAI format, also add <b>AI_BASE_URL</b> and <b>AI_MODEL</b>.
          </li>
          <li>Redeploy (Deployments → ⋯ → Redeploy). New variables only apply after a redeploy.</li>
          <li>Come back here and press Test connection. If something is wrong, the exact reason appears above.</li>
        </ol>
        <button onClick={loadStatus} className="text-sm font-medium underline mt-3" style={{ color: colors.ink }}>
          Refresh provider list
        </button>
      </details>
    </Card>
  );
}

function EmailCard() {
  const [email, setEmail] = useState(null);

  useEffect(() => {
    let alive = true;
    getEmailStatus().then((s) => alive && setEmail(s));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <EnvelopeSimple className="w-4 h-4" style={{ color: colors.ink }} />
        <h3 className="text-sm font-medium" style={{ color: colors.black }}>Sending to customers</h3>
      </div>
      <p className="text-sm mt-1" style={{ color: colors.gray }}>
        “Send to customer” opens your own email app with the reply filled in — free, nothing to set up. You can switch the channel (email, WhatsApp, text message) any time from the send panel in the chat.
      </p>
      <div className="mt-3">
        {email && email.configured ? (
          <Banner kind="success" message="Direct sending is switched on — a “Send directly” button now appears in the send panel." />
        ) : (
          <p className="text-xs" style={{ color: colors.gray }}>
            Direct sending from the platform is optional and currently off. It needs an email service account; you can add that later (RESEND_API_KEY in Vercel) without changing anything else.
          </p>
        )}
      </div>
    </Card>
  );
}

function QueueCard({ autoNext, onAutoNextChange }) {
  return (
    <Card className="p-5">
      <h3 className="text-sm font-medium" style={{ color: colors.black }}>Case queue</h3>
      <p className="text-sm mt-1" style={{ color: colors.gray }}>
        “Get next case” looks for a few seconds, then opens the next case and the assistant starts reading it.
      </p>
      <label className="flex items-start gap-3 mt-4 cursor-pointer">
        <input
          type="checkbox"
          checked={autoNext}
          onChange={(e) => onAutoNextChange(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0"
          style={{ accentColor: colors.black }}
          data-testid="auto-next-toggle"
        />
        <span className="text-sm" style={{ color: colors.ink }}>
          Look for the next case automatically when I finish one
          <span className="block text-xs mt-0.5" style={{ color: colors.gray }}>
            Finishing means sending it on, transferring it or closing it. You can cancel the search while it runs.
          </span>
        </span>
      </label>
    </Card>
  );
}

export default function SettingsView({ onResetAll, autoNext = true, onAutoNextChange = () => {} }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-medium" style={{ color: colors.black }}>Settings</h2>

      <AiConnectionCard />
      <QueueCard autoNext={autoNext} onAutoNextChange={onAutoNextChange} />
      <EmailCard />

      <Card className="p-5">
        <h3 className="text-sm font-medium" style={{ color: colors.black }}>Reset all data</h3>
        <p className="text-sm mt-1" style={{ color: colors.gray }}>
          Clears every case and knowledge-base entry stored in this browser. This can't be undone.
        </p>
        <div className="mt-4">
          {!confirming ? (
            <button onClick={() => setConfirming(true)} className="text-sm font-medium underline" style={{ color: colors.ink }}>
              Reset everything
            </button>
          ) : (
            <span className="text-sm" style={{ color: colors.gray }}>
              Are you sure?{" "}
              <button
                onClick={() => {
                  onResetAll();
                  setConfirming(false);
                }}
                className="font-medium underline"
                style={{ color: colors.black }}
              >
                Yes, reset
              </button>
              {" · "}
              <button onClick={() => setConfirming(false)} className="font-medium underline" style={{ color: colors.gray }}>
                Cancel
              </button>
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
