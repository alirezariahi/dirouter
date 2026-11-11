import { useLocale } from '../i18n.js';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';

const examples = {
  TypeScript: `import OpenAI from 'openai';\n\nconst client = new OpenAI({\n  baseURL: 'http://localhost:8080/v1',\n  apiKey: process.env.DIROUTER_API_KEY,\n});\n\nconst response = await client.chat.completions.create({\n  model: 'your-model-alias',\n  messages: [{ role: 'user', content: 'Hello, DiRouter!' }],\n});`,
  Python: `from openai import OpenAI\nimport os\n\nclient = OpenAI(\n    base_url="http://localhost:8080/v1",\n    api_key=os.environ["DIROUTER_API_KEY"],\n)\n\nresponse = client.chat.completions.create(\n    model="your-model-alias",\n    messages=[{"role": "user", "content": "Hello, DiRouter!"}],\n)`,
  cURL: `curl http://localhost:8080/v1/chat/completions \\\n  -H "Authorization: Bearer $DIROUTER_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "your-model-alias",\n    "messages": [{\n      "role": "user",\n      "content": "Hello, DiRouter!"\n    }]\n  }'`,
};
type Language = keyof typeof examples;
const languages = Object.keys(examples) as Language[];

function Highlight({ code }: { code: string }) {
  const tokens = code.split(
    /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b(?:import|from|const|new|await)\b)/g,
  );
  return (
    <>
      {tokens.map((token, i) => (
        <span
          key={i}
          className={
            /^['"]/.test(token)
              ? 'syntax-string'
              : /^(import|from|const|new|await)$/.test(token)
                ? 'syntax-keyword'
                : undefined
          }
        >
          {token}
        </span>
      ))}
    </>
  );
}

export function Integration() {
  const { t } = useLocale();
  const [language, setLanguage] = useState<Language>('TypeScript');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    [],
  );
  const copy = async () => {
    if (timeout.current) clearTimeout(timeout.current);
    try {
      await navigator.clipboard.writeText(examples[language]);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    timeout.current = setTimeout(() => {
      setCopyState('idle');
    }, 2500);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % languages.length
        : event.key === 'ArrowLeft'
          ? (index + languages.length - 1) % languages.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? languages.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const value = languages[next];
    if (value) setLanguage(value);
    tabs.current[next]?.focus();
  };
  return (
    <div className="integration-window">
      <div className="code-top">
        <span>
          <Terminal size={15} />
          <span>quickstart</span>
        </span>
        <span className="window-dots">
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="code-controls">
        <div className="code-tabs" role="tablist" aria-label={t('زبان نمونه کد')} dir="ltr">
          {languages.map((item, index) => (
            <button
              key={item}
              ref={(el) => {
                tabs.current[index] = el;
              }}
              role="tab"
              id={`code-tab-${item}`}
              aria-controls="code-panel"
              aria-selected={language === item}
              tabIndex={language === item ? 0 : -1}
              onKeyDown={(event) => {
                onKey(event, index);
              }}
              onClick={() => {
                setLanguage(item);
                setCopyState('idle');
              }}
            >
              {item}
            </button>
          ))}
        </div>
        <button className="copy-button" onClick={() => void copy()} aria-label={t('کپی نمونه کد')}>
          {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          <span aria-live="polite">
            {copyState === 'copied'
              ? t('کپی شد')
              : copyState === 'error'
                ? t('کد را انتخاب و کپی کنید')
                : t('کپی کد')}
          </span>
        </button>
      </div>
      <pre
        id="code-panel"
        role="tabpanel"
        aria-labelledby={`code-tab-${language}`}
        tabIndex={0}
        dir="ltr"
      >
        <code>
          {examples[language].split('\n').map((line, i) => (
            <span className="code-line" key={`${language}-${i}`}>
              <span className="line-number" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span>
                <Highlight code={line} />
                {!line && '\u00A0'}
              </span>
            </span>
          ))}
        </code>
      </pre>
      <div className="code-footer">
        <span>
          <span className="tiny-dot" /> {t('آدرس و کلید را با تنظیمات درگاه خود جایگزین کنید.')}
        </span>
        <a
          href="https://github.com/alirezariahi/dirouter/blob/main/README.md#quick-start"
          target="_blank"
          rel="noreferrer"
        >
          {t('راهنمای راه‌اندازی')}
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}
