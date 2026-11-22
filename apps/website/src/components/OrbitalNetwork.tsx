import { useLocale } from '../i18n.js';
import { useRef, type PointerEvent } from 'react';
import { ArrowUpRight, Pause, Play, Orbit, Terminal } from 'lucide-react';

type Props = { paused: boolean; reducedMotion: boolean; onToggle: () => void };

export function OrbitalNetwork({ paused, reducedMotion, onToggle }: Props) {
  const { t } = useLocale();
  const stage = useRef<HTMLDivElement>(null);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (paused || event.pointerType !== 'mouse' || !stage.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    stage.current.style.setProperty(
      '--pointer-x',
      `${((event.clientX - rect.left) / rect.width - 0.5) * 10}px`,
    );
    stage.current.style.setProperty(
      '--pointer-y',
      `${((event.clientY - rect.top) / rect.height - 0.5) * 7}px`,
    );
  };
  const reset = () => {
    stage.current?.style.setProperty('--pointer-x', '0px');
    stage.current?.style.setProperty('--pointer-y', '0px');
  };
  return (
    <div className="network-wrap">
      <div className="orbital-network" ref={stage} onPointerMove={move} onPointerLeave={reset}>
        <div className="network-halo" aria-hidden="true" />
        <div className="planet-horizon" aria-hidden="true" />
        <div className="orbital-dust" aria-hidden="true" />
        <div className="network-plane">
          <svg className="orbit-art" viewBox="0 0 1000 420" fill="none" aria-hidden="true">
            <defs>
              <linearGradient id="orbit-stroke">
                <stop stopColor="#2864f0" stopOpacity=".08" />
                <stop offset=".45" stopColor="#6f9bff" stopOpacity=".65" />
                <stop offset="1" stopColor="#2864f0" stopOpacity=".06" />
              </linearGradient>
              <radialGradient id="orbit-floor">
                <stop stopColor="#2864f0" stopOpacity=".16" />
                <stop offset="1" stopColor="#2864f0" stopOpacity="0" />
              </radialGradient>
            </defs>
            <ellipse cx="500" cy="235" rx="425" ry="165" fill="url(#orbit-floor)" />
            <g stroke="url(#orbit-stroke)" strokeWidth="1">
              <ellipse cx="500" cy="210" rx="370" ry="123" transform="rotate(-13 500 210)" />
              <ellipse cx="500" cy="210" rx="305" ry="148" transform="rotate(23 500 210)" />
              <ellipse cx="500" cy="210" rx="220" ry="176" transform="rotate(-35 500 210)" />
              <ellipse cx="500" cy="210" rx="465" ry="184" opacity=".3" />
            </g>
            <g className="orbit-particles" strokeLinecap="round">
              <ellipse
                className="orbit-traveler t1"
                cx="500"
                cy="210"
                rx="370"
                ry="123"
                transform="rotate(-13 500 210)"
                pathLength="1000"
              />
              <ellipse
                className="orbit-traveler t2"
                cx="500"
                cy="210"
                rx="305"
                ry="148"
                transform="rotate(23 500 210)"
                pathLength="1000"
              />
              <ellipse
                className="orbit-traveler t3"
                cx="500"
                cy="210"
                rx="220"
                ry="176"
                transform="rotate(-35 500 210)"
                pathLength="1000"
              />
            </g>
            <path className="core-route" d="M205 130C340 80 430 120 500 210S720 350 812 285" />
            <path
              className="core-route route-secondary"
              d="M216 291C365 342 435 268 500 210S697 87 800 128"
            />
          </svg>
          <div className="core-shell">
            <span className="core-aura" />
            <div className="core">
              <img src="/brand/mark-white.svg" alt={t('درگاه DiRouter')} width="80" height="80" />
              <span className="core-sheen" />
            </div>
            <span className="core-caption">DIROUTER / CORE</span>
          </div>
          <div className="provider-node provider-openai">
            <div className="satellite-shell">
              <span className="satellite-orbit" />
              <span className="satellite-sphere">
                <Orbit size={28} strokeWidth={1.2} />
              </span>
              <i />
            </div>
            <span className="satellite-label">OpenAI</span>
          </div>
          <div className="provider-node provider-anthropic">
            <div className="satellite-shell">
              <span className="satellite-orbit" />
              <span className="satellite-sphere satellite-anthropic">
                A<span>I</span>
              </span>
              <i />
            </div>
            <span className="satellite-label">Anthropic</span>
          </div>
          <div className="provider-node provider-mistral">
            <div className="satellite-shell">
              <span className="satellite-orbit" />
              <span className="satellite-sphere satellite-mistral">M</span>
              <i />
            </div>
            <span className="satellite-label">Mistral</span>
          </div>
          <div className="provider-node provider-local">
            <div className="satellite-shell">
              <span className="satellite-orbit" />
              <span className="satellite-sphere">
                <Terminal size={26} strokeWidth={1.3} />
              </span>
              <i />
            </div>
            <span className="satellite-label">{t('مدل‌های محلی')}</span>
          </div>
          <span className="orbit-coordinate coordinate-left" aria-hidden="true">
            01 / CONNECT
          </span>
          <span className="orbit-coordinate coordinate-right" aria-hidden="true">
            02 / ORCHESTRATE
          </span>
        </div>
      </div>
      <div className="network-caption">
        <span>
          <span className="tiny-dot" /> {t('یک نقطهٔ اتصال. چندین مسیر ممکن.')}
        </span>
        <button
          onClick={onToggle}
          disabled={reducedMotion}
          aria-pressed={paused}
          aria-label={
            reducedMotion
              ? t('کاهش حرکت مطابق تنظیم دستگاه')
              : paused
                ? t('پخش موشن‌ها')
                : t('توقف موشن‌ها')
          }
        >
          {paused ? <Play size={12} /> : <Pause size={12} />}
          <span>
            {reducedMotion ? t('حرکت کاهش‌یافته') : paused ? t('پخش حرکت') : t('توقف حرکت')}
          </span>
        </button>
        <a href="#routing" aria-label={t('مشاهده دموی مسیریابی')}>
          <ArrowUpRight size={14} />
        </a>
      </div>
    </div>
  );
}
