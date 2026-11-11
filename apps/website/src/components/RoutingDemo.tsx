import { useLocale } from '../i18n.js';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  Circle,
  Code2,
  Play,
  RotateCcw,
  ShieldCheck,
  Waypoints,
} from 'lucide-react';

type Scenario = 'normal' | 'fallback' | 'budget';
type Phase = 'idle' | 'routing' | 'switching' | 'complete';

export function RoutingDemo() {
  const { t } = useLocale();
  const scenarios: { id: Scenario; label: string; description: string }[] = [
    {
      id: 'normal',
      label: t('مسیر عادی'),
      description: t('درخواست به اولین ارائه‌دهندهٔ در دسترس ارسال می‌شود.'),
    },
    {
      id: 'fallback',
      label: t('اختلال ارائه‌دهنده'),
      description: t('وقتی مسیر اصلی پاسخ نمی‌دهد، ارائه‌دهندهٔ بعدی انتخاب می‌شود.'),
    },
    {
      id: 'budget',
      label: t('سیاست هزینه'),
      description: t('با اولویت‌بندی مدل‌ها، مسیر درخواست را متناسب با سیاست هزینه تعریف کنید.'),
    },
  ];

  const [scenario, setScenario] = useState<Scenario>('fallback');
  const [phase, setPhase] = useState<Phase>('idle');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancel = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const run = () => {
    cancel();
    setPhase('routing');
    if (scenario === 'fallback')
      timers.current.push(
        setTimeout(() => {
          setPhase('switching');
        }, 1350),
      );
    timers.current.push(
      setTimeout(
        () => {
          setPhase('complete');
        },
        scenario === 'fallback' ? 3000 : 1650,
      ),
    );
  };
  const select = (next: Scenario) => {
    cancel();
    setScenario(next);
    setPhase('idle');
  };
  const running = phase === 'routing' || phase === 'switching';
  const target =
    scenario === 'budget'
      ? 2
      : scenario === 'fallback' && (phase === 'switching' || phase === 'complete')
        ? 1
        : 0;
  const description = scenarios.find((item) => item.id === scenario)?.description;
  const status =
    phase === 'idle'
      ? t('آمادهٔ دریافت درخواست')
      : phase === 'routing'
        ? t('بررسی سیاست و انتخاب مسیر…')
        : phase === 'switching'
          ? t('مسیر اصلی در دسترس نیست؛ انتقال به Anthropic…')
          : t('پاسخ از {provider} دریافت شد.').replace(
              '{provider}',
              ['OpenAI', 'Anthropic', 'Mistral'][target] ?? '',
            );
  return (
    <div className="routing-demo" data-phase={phase} data-target={target}>
      <div className="demo-toolbar">
        <span className="demo-label">
          <span className="tiny-dot" /> {t('آزمایشگاه مسیریابی')}
        </span>
        <span className="demo-watermark">INTERACTIVE DEMO</span>
      </div>
      <div className="scenario-tabs" role="group" aria-label={t('سناریوی مسیریابی')}>
        {scenarios.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => {
              select(id);
            }}
            aria-pressed={scenario === id}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="demo-canvas" aria-label={t('مسیر درخواست از برنامه، به درگاه و ارائه‌دهنده')}>
        <div className={`demo-endpoint source-endpoint ${phase !== 'idle' ? 'is-active' : ''}`}>
          <Code2 />
          <span>Your app</span>
          <small>REQUEST</small>
        </div>
        <div className={`demo-wire input-wire ${running ? 'is-flowing' : ''}`}>
          <span />
        </div>
        <div className={`demo-gateway ${running ? 'is-processing' : ''}`}>
          <img src="/brand/mark-white.svg" width="54" height="54" alt="DiRouter" />
          <span>DiRouter</span>
        </div>
        <div className="branch-wires" aria-hidden="true">
          <svg viewBox="0 0 100 200" preserveAspectRatio="none">
            <path
              className={phase !== 'idle' && target === 0 ? 'is-active' : ''}
              d="M0 100H20Q45 100 45 65V35Q45 25 60 25H100"
            />
            <path className={phase !== 'idle' && target === 1 ? 'is-active' : ''} d="M0 100H100" />
            <path
              className={phase !== 'idle' && target === 2 ? 'is-active' : ''}
              d="M0 100H20Q45 100 45 135V165Q45 175 60 175H100"
            />
          </svg>
        </div>
        <div className="demo-providers">
          {['OpenAI', 'Anthropic', 'Mistral'].map((name, index) => {
            const active = phase !== 'idle' && target === index;
            const failed =
              scenario === 'fallback' &&
              index === 0 &&
              (phase === 'switching' || phase === 'complete');
            return (
              <div
                key={name}
                className={`demo-provider ${active ? 'is-active' : ''} ${failed ? 'is-unavailable' : ''}`}
              >
                <span>{name}</span>
                {failed ? (
                  <span className="provider-unavailable">×</span>
                ) : active && phase === 'complete' ? (
                  <Check size={14} />
                ) : (
                  <Circle size={7} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="demo-status" role="status" aria-live="polite">
        {phase === 'complete' ? <ShieldCheck size={16} /> : <Waypoints size={16} />}
        <span>{status}</span>
        <span className="demo-status-code" dir="ltr">
          {phase === 'complete' ? 'RESPONSE / OK' : phase === 'idle' ? 'READY' : 'ROUTING'}
        </span>
      </div>
      <div className="demo-bottom">
        <p>{description}</p>
        <button className="button button-small" onClick={run} disabled={running}>
          {phase === 'complete' ? <RotateCcw size={14} /> : <Play size={14} />}{' '}
          {running
            ? t('در حال مسیریابی')
            : phase === 'complete'
              ? t('اجرای دوباره')
              : t('ارسال درخواست')}
          {!running && <ArrowLeft size={14} />}
        </button>
      </div>
      <p className="demo-disclaimer">
        {t('شبیه‌سازی نمایشی؛ درخواستی به سرویس‌های واقعی ارسال نمی‌شود.')}
      </p>
    </div>
  );
}
