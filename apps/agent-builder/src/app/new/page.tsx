'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PERSONAS, TONES, getPersona } from '@/lib/personas';
import type { SystemStatus, ToneKey, WizardSubmission } from '@/lib/types';

const STEP_LABELS = ['Choose its job', 'Make it yours', 'Channels & skills', 'Meet your agent'];

interface BuildState {
  stage: number; // index into stages; -1 = not building
  error?: string;
}

export default function NewAgentPage() {
  const router = useRouter();

  // ── wizard state ──
  const [step, setStep] = useState(0);
  const [personaKey, setPersonaKey] = useState<string>('');
  const [agentName, setAgentName] = useState('');
  const [operatorName, setOperatorName] = useState('');
  const [addressAs, setAddressAs] = useState('');
  const [audience, setAudience] = useState('');
  const [mission, setMission] = useState('');
  const [tone, setTone] = useState<ToneKey>('warm-professional');
  const [remember, setRemember] = useState('');
  const [neverShare, setNeverShare] = useState('');
  const [telegram, setTelegram] = useState(false);
  const [voice, setVoice] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [github, setGithub] = useState(false);
  const [google, setGoogle] = useState(false);
  const [keyProvider, setKeyProvider] = useState<'anthropic' | 'openai' | 'groq' | 'openrouter'>('anthropic');
  const [keyValue, setKeyValue] = useState('');

  const [system, setSystem] = useState<SystemStatus | null>(null);
  const [build, setBuild] = useState<BuildState>({ stage: -1 });
  const stageTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const persona = useMemo(() => getPersona(personaKey), [personaKey]);

  useEffect(() => {
    fetch('/api/system')
      .then((r) => r.json())
      .then((s: SystemStatus) => setSystem(s))
      .catch(() => setSystem(null));
  }, []);

  function choosePersona(key: string) {
    setPersonaKey(key);
    const p = getPersona(key);
    if (p) {
      setTone(p.defaultTone);
      if (!agentName.trim()) setAgentName(p.suggestedName);
    }
  }

  const displayName = agentName.trim() || persona?.suggestedName || 'your agent';
  const needsKey = system !== null && system.plan === null;
  const canBuild = Boolean(persona) && operatorName.trim().length > 0 && (!needsKey || keyValue.trim());

  const stages = [
    `Creating ${displayName}’s home`,
    `Writing ${displayName}’s identity`,
    'Switching on private local memory',
    'Arming the memory safety screen',
    `Waking ${displayName} up`,
  ];

  async function startBuild() {
    if (!persona || !canBuild) return;
    setBuild({ stage: 0 });
    // The build request does stages 0–3 in one shot; pace the first lines so
    // the moment reads, then hold until the API answers.
    let paced = 0;
    stageTimer.current = setInterval(() => {
      paced = Math.min(paced + 1, 2);
      setBuild((b) => (b.error ? b : { stage: Math.max(b.stage, paced) }));
    }, 750);

    const submission: WizardSubmission = {
      personaKey: persona.key,
      agentName: displayName,
      operatorName: operatorName.trim(),
      addressAs: addressAs.trim() || undefined,
      audience: audience.trim() || undefined,
      mission: mission.trim() || persona.missionPlaceholder,
      tone,
      remember: remember.trim() || undefined,
      neverShare: neverShare.trim() || undefined,
      channels: { telegram, voice },
      skills: { webSearch, github, google },
      modelKey: needsKey && keyValue.trim() ? { provider: keyProvider, value: keyValue.trim() } : undefined,
    };

    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(submission),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `build failed (${res.status})`);
      if (stageTimer.current) clearInterval(stageTimer.current);
      setBuild({ stage: 3 });
      await new Promise((r) => setTimeout(r, 650));
      setBuild({ stage: 4 });

      const gw = await fetch(`/api/agents/${json.slug}/gateway`, { method: 'POST' });
      const gwJson = await gw.json();
      if (!gw.ok) throw new Error(gwJson.error || 'gateway failed to start');

      router.push(`/agents/${json.slug}?welcome=1`);
    } catch (err) {
      if (stageTimer.current) clearInterval(stageTimer.current);
      setBuild({ stage: -1, error: (err as Error).message });
    }
  }

  useEffect(() => () => {
    if (stageTimer.current) clearInterval(stageTimer.current);
  }, []);

  return (
    <main>
      <div className="steps">
        {STEP_LABELS.map((label, i) => (
          <span key={label} style={{ display: 'contents' }}>
            <span className={`step ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}>
              <span className="num">{i + 1}</span> {label}
            </span>
            {i < STEP_LABELS.length - 1 && <span className="bar" />}
          </span>
        ))}
      </div>

      {step === 0 && (
        <section>
          <h1 className="wizard-title">What should your agent do?</h1>
          <p className="wizard-sub">
            Pick a starting point — you’ll make it yours in the next step.
          </p>
          <div className="persona-grid">
            {PERSONAS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`persona-card ${personaKey === p.key ? 'selected' : ''}`}
                onClick={() => choosePersona(p.key)}
              >
                <span className="tick" />
                <span className="emoji">{p.emoji}</span>
                <h3>{p.title}</h3>
                <p className="tagline">{p.tagline}</p>
                <ul>
                  {p.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </button>
            ))}
          </div>
          <div className="wizard-nav">
            <span />
            <button type="button" className="btn primary" disabled={!persona} onClick={() => setStep(1)}>
              Continue →
            </button>
          </div>
        </section>
      )}

      {step === 1 && persona && (
        <section style={{ maxWidth: 620 }}>
          <h1 className="wizard-title">Make {persona.title.toLowerCase()} yours</h1>
          <p className="wizard-sub">A few friendly questions. Skip anything you’re unsure about.</p>

          <div className="field-row">
            <div className="field">
              <label htmlFor="agent-name">Agent’s name</label>
              <input
                id="agent-name"
                type="text"
                value={agentName}
                placeholder={persona.suggestedName}
                onChange={(e) => setAgentName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="op-name">
                Your name <span className="hint">(so it knows who it works for)</span>
              </label>
              <input
                id="op-name"
                type="text"
                value={operatorName}
                placeholder="e.g. Rez Juarez"
                onChange={(e) => setOperatorName(e.target.value)}
              />
            </div>
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="address-as">
                What should it call you? <span className="hint">(optional)</span>
              </label>
              <input
                id="address-as"
                type="text"
                value={addressAs}
                placeholder={operatorName.trim().split(/\s+/)[0] || 'e.g. Rez'}
                onChange={(e) => setAddressAs(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="audience">
                Who is it for? <span className="hint">(optional)</span>
              </label>
              <input
                id="audience"
                type="text"
                value={audience}
                placeholder="Just me / my shop’s customers / my team…"
                onChange={(e) => setAudience(e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="mission">What should {displayName} help with?</label>
            <textarea
              id="mission"
              value={mission}
              placeholder={persona.missionPlaceholder}
              onChange={(e) => setMission(e.target.value)}
            />
          </div>

          <div className="field">
            <label>How should {displayName} sound?</label>
            <div className="pills">
              {TONES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={`pill ${tone === t.key ? 'selected' : ''}`}
                  onClick={() => setTone(t.key)}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="remember">
              What should it always remember? <span className="hint">(optional)</span>
            </label>
            <textarea
              id="remember"
              value={remember}
              placeholder={persona.rememberPlaceholder}
              onChange={(e) => setRemember(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="never">
              Anything it should never share? <span className="hint">(optional, one per line)</span>
            </label>
            <textarea
              id="never"
              value={neverShare}
              placeholder={'Home address\nFamily details'}
              onChange={(e) => setNeverShare(e.target.value)}
            />
          </div>

          <div className="wizard-nav">
            <button type="button" className="btn quiet" onClick={() => setStep(0)}>
              ← Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={!operatorName.trim()}
              onClick={() => setStep(2)}
            >
              Continue →
            </button>
          </div>
        </section>
      )}

      {step === 2 && persona && (
        <section style={{ maxWidth: 680 }}>
          <h1 className="wizard-title">Where can people reach {displayName}?</h1>
          <p className="wizard-sub">Chat works right away. The rest switch on when you’re ready.</p>

          <div className="option-grid">
            <div className="option-card on locked">
              <span className="opt-emoji">💬</span>
              <span className="opt-body">
                <h4>Web chat</h4>
                <p>Talk to {displayName} right here, in your browser.</p>
                <span className="badge good">Included</span>
              </span>
            </div>
            <button type="button" className={`option-card ${telegram ? 'on' : ''}`} onClick={() => setTelegram(!telegram)}>
              <span className="opt-emoji">📨</span>
              <span className="opt-body">
                <h4>Telegram</h4>
                <p>Message your agent from your phone.</p>
                <span className="badge">Add a bot token later</span>
              </span>
              <span className="switch" />
            </button>
            <button type="button" className={`option-card ${voice ? 'on' : ''}`} onClick={() => setVoice(!voice)}>
              <span className="opt-emoji">📞</span>
              <span className="opt-body">
                <h4>Voice & phone</h4>
                <p>Give your agent a phone number people can call.</p>
                <span className="badge">Add a VAPI number later</span>
              </span>
              <span className="switch" />
            </button>
          </div>

          <h2 className="section">What should {displayName} know how to do?</h2>
          <div className="option-grid">
            <button type="button" className={`option-card ${webSearch ? 'on' : ''}`} onClick={() => setWebSearch(!webSearch)}>
              <span className="opt-emoji">🔎</span>
              <span className="opt-body">
                <h4>Web search</h4>
                <p>Look things up on the live web when asked.</p>
              </span>
              <span className="switch" />
            </button>
            <button type="button" className={`option-card ${github ? 'on' : ''}`} onClick={() => setGithub(!github)}>
              <span className="opt-emoji">🐙</span>
              <span className="opt-body">
                <h4>GitHub</h4>
                <p>Track issues and pull requests with you.</p>
                <span className="badge">Connect your account later</span>
              </span>
              <span className="switch" />
            </button>
            <button type="button" className={`option-card ${google ? 'on' : ''}`} onClick={() => setGoogle(!google)}>
              <span className="opt-emoji">📅</span>
              <span className="opt-body">
                <h4>Google</h4>
                <p>Calendar and email awareness.</p>
                <span className="badge">Connect your account later</span>
              </span>
              <span className="switch" />
            </button>
          </div>

          <div className="wizard-nav">
            <button type="button" className="btn quiet" onClick={() => setStep(1)}>
              ← Back
            </button>
            <button type="button" className="btn primary" onClick={() => setStep(3)}>
              Continue →
            </button>
          </div>
        </section>
      )}

      {step === 3 && persona && (
        <section style={{ maxWidth: 620 }}>
          <h1 className="wizard-title">Ready to meet {displayName}?</h1>
          <p className="wizard-sub">One last look. You can change all of this later.</p>

          <div className="card pad review-list">
            <div className="review-row">
              <span className="k">Job</span>
              <span className="v">
                {persona.emoji} {persona.title}
              </span>
            </div>
            <div className="review-row">
              <span className="k">Name</span>
              <span className="v">{displayName}</span>
            </div>
            <div className="review-row">
              <span className="k">Works for</span>
              <span className="v">{operatorName || '—'}</span>
            </div>
            <div className="review-row">
              <span className="k">Sounds</span>
              <span className="v">{TONES.find((t) => t.key === tone)?.label}</span>
            </div>
            <div className="review-row">
              <span className="k">Channels</span>
              <span className="v">
                Web chat{telegram ? ' · Telegram' : ''}
                {voice ? ' · Voice' : ''}
              </span>
            </div>
            <div className="review-row">
              <span className="k">Skills</span>
              <span className="v">
                {[webSearch && 'Web search', github && 'GitHub', google && 'Google']
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </span>
            </div>
            <div className="review-row">
              <span className="k">Memory</span>
              <span className="v">Private, on this computer — safety screen on</span>
            </div>
          </div>

          {system === null && (
            <div className="notice warn">⏳ Checking what can power {displayName} on this computer…</div>
          )}
          {system?.plan && (
            <div className="notice good">
              ✓ {displayName} will think with {system.plan.label}. Nothing leaves this machine
              unless you add cloud skills.
            </div>
          )}
          {needsKey && (
            <div className="card pad" style={{ marginTop: 14 }}>
              <div className="notice warn" style={{ marginTop: 0 }}>
                No local AI found (Ollama isn’t running). Paste one API key and {displayName} can
                think in the cloud — or install Ollama for fully local.
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="key-provider">Provider</label>
                  <select
                    id="key-provider"
                    value={keyProvider}
                    onChange={(e) => setKeyProvider(e.target.value as typeof keyProvider)}
                  >
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="groq">Groq (free tier)</option>
                    <option value="openai">OpenAI</option>
                    <option value="openrouter">OpenRouter</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="key-value">API key</label>
                  <input
                    id="key-value"
                    type="password"
                    value={keyValue}
                    placeholder="Stored only in your agent’s private settings"
                    onChange={(e) => setKeyValue(e.target.value)}
                  />
                </div>
              </div>
            </div>
          )}

          {build.error && <div className="notice bad">✕ {build.error}</div>}

          <div className="wizard-nav">
            <button type="button" className="btn quiet" onClick={() => setStep(2)}>
              ← Back
            </button>
            <button type="button" className="btn primary lg" disabled={!canBuild} onClick={startBuild}>
              ✦ Build my agent
            </button>
          </div>
        </section>
      )}

      {build.stage >= 0 && (
        <div className="overlay">
          <div className="orb" />
          <h2>Bringing {displayName} to life…</h2>
          <div className="stage-list">
            {stages.map((label, i) => (
              <div
                key={label}
                className={`stage ${i === build.stage ? 'active' : ''} ${i < build.stage ? 'done' : ''}`}
              >
                <span className="stage-dot" />
                {label}
              </div>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
