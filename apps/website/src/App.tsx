import { useLocale } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUpLeft,
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleDollarSign,
  Code2,
  Cpu,
  ExternalLink,
  GitFork,
  Layers3,
  Languages,
  Menu,
  Network,
  ShieldCheck,
  Waypoints,
  X,
  Zap,
} from 'lucide-react';
import { OrbitalNetwork } from './components/OrbitalNetwork.js';
import { RoutingDemo } from './components/RoutingDemo.js';
import { Integration } from './components/Integration.js';

const repository = 'https://github.com/alirezariahi/dirouter';

function Brand({ footer = false }: { footer?: boolean }) {
  const { t } = useLocale();
  return (
    <a
      href="#top"
      className={`brand ${footer ? 'brand-footer' : ''}`}
      aria-label={t('DiRouter — ابتدای صفحه')}
    >
      <img src="/brand/mark-blue.svg" width="36" height="36" alt="" />
      <span>
        DiRouter<span className="brand-period">.</span>
      </span>
    </a>
  );
}

export function App() {
  const { t, locale, setLocale } = useLocale();
  const links = [
    { href: '#capabilities', text: t('قابلیت‌ها') },
    { href: '#routing', text: t('مسیریابی هوشمند') },
    { href: '#integration', text: t('توسعه‌دهندگان') },
  ];
  const questions = [
    {
      q: t('DiRouter دقیقاً چه کاری انجام می‌دهد؟'),
      a: t(
        'DiRouter میان برنامهٔ شما و ارائه‌دهنده‌های مدل قرار می‌گیرد. درخواست‌ها از یک درگاه مشترک عبور می‌کنند و بر اساس تنظیمات مسیریابی، به مدل و ارائه‌دهندهٔ انتخابی می‌رسند. فال‌بک، کنترل مصرف و حسابداری نیز در همین لایه مدیریت می‌شوند.',
      ),
    },
    {
      q: t('آیا باید SDK یا کد برنامه‌ام را عوض کنم؟'),
      a: t(
        'درگاه برای رابط‌های سازگار با OpenAI و Anthropic طراحی شده است. در اتصال‌های سازگار، معمولاً آدرس پایه، کلید دسترسی و نام مدل را تغییر می‌دهید. جزئیات پشتیبانی هر قابلیت را در مستندات بررسی کنید.',
      ),
    },
    {
      q: t('اگر یک ارائه‌دهنده قطع شود چه اتفاقی می‌افتد؟'),
      a: t(
        'اگر زنجیرهٔ جایگزین را تنظیم کرده باشید، درگاه بر اساس نوع خطا، timeout و وضعیت مدارشکن، مسیر بعدی را امتحان می‌کند. در پاسخ‌های جریانی، تغییر مسیر فقط پیش از ارسال اولین بایت پاسخ امکان‌پذیر است.',
      ),
    },
    {
      q: t('می‌توانم مدل‌های محلی خودم را متصل کنم؟'),
      a: t(
        'بله؛ معماری پروژه آداپترهایی برای Ollama، vLLM و سرویس‌های سازگار با OpenAI در نظر گرفته است. وضعیت پیاده‌سازی و تنظیمات هر آداپتر در مستندات همان ارائه‌دهنده مشخص می‌شود.',
      ),
    },
  ];

  const [menuOpen, setMenuOpen] = useState(false);
  const [manualPause, setManualPause] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [documentHidden, setDocumentHidden] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const paused = manualPause || reducedMotion || documentHidden;

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      setReducedMotion(query.matches);
    };
    const visibility = () => {
      setDocumentHidden(document.hidden);
    };
    sync();
    visibility();
    query.addEventListener('change', sync);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      query.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  useEffect(() => {
    const items = root.current?.querySelectorAll<HTMLElement>('[data-reveal]');
    if (!items || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 },
    );
    items.forEach((item) => {
      item.classList.add('will-reveal');
      observer.observe(item);
    });
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  return (
    <div className={`website ${paused ? 'motion-paused' : ''}`} ref={root} id="top">
      <a className="skip-link" href="#main-content">
        {t('رفتن به محتوای اصلی')}
      </a>
      <div className="ambient-stars" aria-hidden="true" />
      <div className="cosmic-atmosphere" aria-hidden="true">
        <div className="nebula nebula-blue" />
        <div className="nebula nebula-violet" />
        {Array.from({ length: 64 }, (_, i) => (
          <i
            key={i}
            className={i % 11 === 0 ? 'deep-star bright-star' : 'deep-star'}
            style={{
              left: `${(i * 73 + 13) % 100}%`,
              top: `${(i * 37 + 7) % 100}%`,
              animationDelay: `${-i * 0.73}s`,
              animationDuration: `${5 + (i % 7)}s`,
            }}
          />
        ))}
      </div>
      <header className="header">
        <div className="header-inner container">
          <Brand />
          <nav className="desktop-nav" aria-label={t('ناوبری اصلی')}>
            {links.map((link) => (
              <a key={link.href} href={link.href}>
                {link.text}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className="language-toggle"
              onClick={() => {
                setLocale(locale === 'fa' ? 'en' : 'fa');
              }}
              aria-label={locale === 'fa' ? 'Switch to English' : 'تغییر زبان به فارسی'}
              lang={locale === 'fa' ? 'en' : 'fa'}
              dir="ltr"
            >
              <Languages size={15} />
              <span>{locale === 'fa' ? 'EN' : 'فارسی'}</span>
            </button>
            <a
              className="github-link"
              href={repository}
              target="_blank"
              rel="noreferrer"
              aria-label={t('کد پروژه در گیت‌هاب')}
            >
              <GitFork size={18} />
            </a>
            <a href="#integration" className="header-cta">
              {t('شروع اتصال')}
              <ArrowUpLeft size={14} />
            </a>
            <button
              ref={menuButton}
              className="menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="mobile-menu"
              aria-label={menuOpen ? t('بستن منو') : t('باز کردن منو')}
              onClick={() => {
                setMenuOpen(!menuOpen);
              }}
            >
              {menuOpen ? <X size={21} /> : <Menu size={21} />}
            </button>
          </div>
        </div>
        <nav
          id="mobile-menu"
          className="mobile-menu"
          aria-label={t('ناوبری موبایل')}
          hidden={!menuOpen}
        >
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => {
                setMenuOpen(false);
              }}
            >
              {link.text}
              <ArrowUpLeft size={15} />
            </a>
          ))}
          <a
            href="#faq"
            onClick={() => {
              setMenuOpen(false);
            }}
          >
            {t('پرسش‌های متداول')}
            <ArrowUpLeft size={15} />
          </a>
        </nav>
      </header>

      <main id="main-content">
        <section className="hero container" aria-labelledby="hero-title">
          <div className="hero-eyebrow enter">
            <span className="signal-dot" />
            <span>{t('یک لایهٔ هوشمند میان شما و مدل‌ها')}</span>
            <span className="eyebrow-separator" />
            <span className="english">MEET DIROUTER</span>
          </div>
          <h1 className="enter enter-1" id="hero-title">
            {t('همهٔ مدل‌ها.')}
            <br />
            <span className="hero-gradient">{t('یک مدار هوشمند.')}</span>
          </h1>
          <p className="hero-description enter enter-2">
            {t('مدل‌ها را به هم متصل کنید؛ نه پیچیدگی‌ها را.')}
            <br />
            {t('یک درگاه برای مسیریابی درخواست‌ها، کنترل هزینه و ادامهٔ سرویس.')}
          </p>
          <div className="hero-actions enter enter-3">
            <a className="button button-primary" href="#routing">
              {t('مسیریابی را تجربه کنید')}
              <ArrowLeft size={17} />
            </a>
            <a className="button button-secondary" href="#integration">
              <Code2 size={17} /> {t('با کد شروع کنید')}
            </a>
          </div>
          <div className="hero-visual enter enter-4">
            <OrbitalNetwork
              paused={paused}
              reducedMotion={reducedMotion}
              onToggle={() => {
                if (!reducedMotion) setManualPause(!manualPause);
              }}
            />
          </div>
          <a href="#providers" className="scroll-cue" aria-label={t('ادامهٔ صفحه')}>
            <span />
            <ArrowDown size={13} />
          </a>
        </section>

        <section
          className="provider-section container"
          id="providers"
          aria-label={t('ارائه‌دهنده‌های معماری DiRouter')}
        >
          <p>
            {t('مدل‌های متفاوت.')}
            <span>{t('یک زبان مشترک.')}</span>
          </p>
          <div className="provider-strip">
            <span>
              <span className="provider-glyph">◎</span> OpenAI
            </span>
            <span className="anthropic-word">ANTHROPIC</span>
            <span>
              <span className="mistral-glyph">M</span> Mistral
            </span>
            <span>
              <Zap size={19} /> Groq
            </span>
            <span>
              <Cpu size={20} /> Ollama
            </span>
            <span>
              <Layers3 size={19} /> vLLM
            </span>
          </div>
          <div className="section-divider">
            <span />
          </div>
        </section>

        <section
          className="manifesto container"
          id="capabilities"
          aria-labelledby="manifesto-title"
        >
          <div className="section-heading" data-reveal>
            <div>
              <div className="eyebrow">
                <span /> CONNECT. ROUTE. CONTROL.
              </div>
              <h2 id="manifesto-title">
                {t('شما روی ساختن تمرکز کنید.')}
                <br />
                <span className="muted-heading">{t('مسیر را به DiRouter بسپارید.')}</span>
              </h2>
            </div>
            <p>
              {t('از اولین درخواست تا انتخاب مسیر جایگزین،')}
              <br className="desktop-break" /> {t('یک لایهٔ منسجم بین محصول شما و مدل‌ها.')}
            </p>
          </div>
          <div className="principles">
            <article data-reveal>
              <div className="principle-top">
                <Network size={24} />
                <span>01 / CONNECT</span>
              </div>
              <h3>{t('یک اتصال. انتخاب‌های بیشتر.')}</h3>
              <p>
                {t(
                  'ارائه‌دهنده‌های مختلف را پشت یک API مشترک قرار دهید؛ با رابط‌های سازگار با OpenAI و Anthropic.',
                )}
              </p>
              <span className="principle-note">
                <Check size={12} /> {t('یکپارچه با ابزارهای شما')}
              </span>
            </article>
            <article data-reveal>
              <div className="principle-top">
                <Waypoints size={24} />
                <span>02 / RECOVER</span>
              </div>
              <h3>{t('همیشه یک مسیر دیگر.')}</h3>
              <p>
                {t(
                  'خطا، timeout یا اختلال ارائه‌دهنده؛ با زنجیرهٔ فال‌بک و مدارشکن، مسیر جایگزین را آماده نگه دارید.',
                )}
              </p>
              <span className="principle-note">
                <Check size={12} /> {t('طراحی‌شده برای تاب‌آوری')}
              </span>
            </article>
            <article data-reveal>
              <div className="principle-top">
                <CircleDollarSign size={24} />
                <span>03 / CONTROL</span>
              </div>
              <h3>{t('کنترل، در اختیار شما.')}</h3>
              <p>
                {t(
                  'مصرف و بودجه را در سطح پروژه و تیم مدیریت کنید. بدانید هر درخواست کجا رفته و چه هزینه‌ای داشته است.',
                )}
              </p>
              <span className="principle-note">
                <Check size={12} /> {t('دید روشن‌تر به مصرف')}
              </span>
            </article>
          </div>
        </section>

        <section className="routing-section" id="routing" aria-labelledby="routing-title">
          <div className="routing-glow" aria-hidden="true" />
          <div className="container routing-layout">
            <div className="routing-copy" data-reveal>
              <div className="eyebrow">
                <span /> INTELLIGENCE IN MOTION
              </div>
              <h2 id="routing-title">
                {t('وقتی یک مسیر بسته شد،')}
                <br />
                <span className="text-blue">{t('مسیر بعدی باز است.')}</span>
              </h2>
              <p>
                {t(
                  'هوشمندی فقط در مدل نیست؛ در انتخاب مسیر هم هست. سیاست‌ها را تعریف کنید و ببینید درخواست چطور به مقصد می‌رسد.',
                )}
              </p>
              <div className="routing-steps">
                <div>
                  <span>{t('۱')}</span>
                  <p>
                    <strong>{t('درخواست را دریافت می‌کنیم')}</strong>
                    {t('یک رابط مشترک برای محصول شما')}
                  </p>
                </div>
                <div>
                  <span>{t('۲')}</span>
                  <p>
                    <strong>{t('مسیر را با سیاست شما تطبیق می‌دهیم')}</strong>
                    {t('اولویت، دسترس‌پذیری و محدودیت‌ها')}
                  </p>
                </div>
                <div>
                  <span>{t('۳')}</span>
                  <p>
                    <strong>{t('پاسخ را به همان رابط برمی‌گردانیم')}</strong>
                    {t('با حفظ قالب درخواست اولیه')}
                  </p>
                </div>
              </div>
              <a
                href={`${repository}/blob/main/ARCHITECTURE.md`}
                className="text-link"
                target="_blank"
                rel="noreferrer"
              >
                {t('نگاهی به معماری')}
                <ArrowUpLeft size={15} />
              </a>
            </div>
            <div data-reveal>
              <RoutingDemo />
            </div>
          </div>
        </section>

        <section className="control-section container" aria-labelledby="control-title">
          <div className="section-heading" data-reveal>
            <div>
              <div className="eyebrow">
                <span /> BUILT FOR THE REAL WORLD
              </div>
              <h2 id="control-title">
                {t('پشت این سادگی،')}
                <br />
                {t('همه‌چیز تحت کنترل است.')}
              </h2>
            </div>
            <p>
              {t('جزئیاتی که یک اتصال ساده را')}
              <br />
              {t('به زیرساختی قابل اتکا تبدیل می‌کنند.')}
            </p>
          </div>
          <div className="control-grid">
            <article className="control-card budget-card" data-reveal>
              <div className="card-icon">
                <CircleDollarSign size={21} />
              </div>
              <h3>{t('بودجه را قبل از مصرف تعریف کنید.')}</h3>
              <p>
                {t('کلیدهای مجازی، محدودیت درخواست و سقف بودجه؛')}
                <br />
                {t('سیاست‌هایی روشن برای پروژه‌ها و تیم‌ها.')}
              </p>
              <div className="policy-preview" dir="ltr">
                <div className="policy-header">
                  <span>
                    <span className="tiny-dot" /> PROJECT POLICY
                  </span>
                  <span>example</span>
                </div>
                <div className="policy-row">
                  <span>project / production</span>
                  <span className="policy-tag">managed</span>
                </div>
                <div className="policy-option">
                  <span>Budget limit</span>
                  <span>
                    <Check size={12} /> Defined by you
                  </span>
                </div>
                <div className="policy-option">
                  <span>Rate limit</span>
                  <span>
                    <Check size={12} /> Per project
                  </span>
                </div>
                <div className="policy-option">
                  <span>Usage accounting</span>
                  <span>
                    <Check size={12} /> Request-level
                  </span>
                </div>
                <div className="policy-bottom">
                  <ShieldCheck size={13} />
                  <span>Your infrastructure. Your rules.</span>
                </div>
              </div>
            </article>
            <article className="control-card resilience-card" data-reveal>
              <div className="card-icon">
                <ShieldCheck size={21} />
              </div>
              <h3>{t('مستقل، در لحظه‌های مهم.')}</h3>
              <p>
                {t('مسیر درخواست از لایهٔ مدیریت جداست؛')}
                <br />
                {t('با آخرین تنظیمات سالم، سرویس ادامه پیدا می‌کند.')}
              </p>
              <div className="resilience-visual" aria-label={t('لایهٔ داده مستقل از لایهٔ کنترل')}>
                <div className="plane">
                  <span className="plane-status" />
                  <span>Data plane</span>
                  <span className="plane-live">SERVING</span>
                  <AudioLines size={27} />
                </div>
                <div className="snapshot-line">
                  <span />
                  <span className="snapshot-label">LAST HEALTHY SNAPSHOT</span>
                  <span />
                </div>
                <div className="plane plane-secondary">
                  <Layers3 size={20} />
                  <span>Control plane</span>
                  <span className="plane-live">INDEPENDENT</span>
                </div>
              </div>
            </article>
            <article className="control-card compact-card" data-reveal>
              <div className="card-icon">
                <Layers3 size={21} />
              </div>
              <div>
                <h3>{t('مدل محلی یا سرویس ابری؟ هر دو.')}</h3>
                <p>
                  {t(
                    'با آداپترهای ارائه‌دهنده‌ها، مدل‌های محلی و ابری را در یک ساختار مشترک تعریف کنید.',
                  )}
                </p>
              </div>
              <span className="compact-detail english">
                CLOUD + LOCAL <ArrowUpRight size={18} />
              </span>
            </article>
          </div>
        </section>

        <section
          className="integration-section container"
          id="integration"
          aria-labelledby="integration-title"
        >
          <div className="integration-copy" data-reveal>
            <div className="eyebrow">
              <span /> FAMILIAR CODE. NEW POSSIBILITIES.
            </div>
            <h2 id="integration-title">
              {t('ابزارهای آشنا.')}
              <br />
              <span className="muted-heading">{t('امکان‌های تازه.')}</span>
            </h2>
            <p>
              {t(
                'با SDK سازگار خودتان شروع کنید. آدرس درگاه، کلید دسترسی و نام مدل را تنظیم کنید؛ باقی مسیر از یک نقطه مدیریت می‌شود.',
              )}
            </p>
            <div className="integration-checks">
              <span>
                <Check size={15} /> {t('سازگار با رابط OpenAI')}
              </span>
              <span>
                <Check size={15} /> {t('پشتیبانی از قالب Anthropic')}
              </span>
              <span>
                <Check size={15} /> {t('پاسخ عادی و جریانی')}
              </span>
            </div>
            <a
              href={`${repository}/blob/main/DOCUMENTATION.md`}
              className="text-link"
              target="_blank"
              rel="noreferrer"
            >
              {t('مستندات فنی')}
              <ExternalLink size={14} />
            </a>
          </div>
          <div data-reveal>
            <Integration />
          </div>
        </section>

        <section className="faq-section container" id="faq" aria-labelledby="faq-title">
          <div data-reveal>
            <div className="eyebrow">
              <span /> A LITTLE MORE CLARITY
            </div>
            <h2 id="faq-title">{t('قبل از اولین اتصال.')}</h2>
            <p>{t('چند پاسخ برای شروع مسیر.')}</p>
          </div>
          <div className="faq-list" data-reveal>
            {questions.map(({ q, a }) => (
              <details key={q}>
                <summary>
                  <span>{q}</span>
                  <ChevronDown size={17} />
                </summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="closing-section container" data-reveal aria-labelledby="closing-title">
          <div className="closing-orbit" aria-hidden="true" />
          <div className="closing-mark" aria-hidden="true">
            <img src="/brand/mark-white.svg" alt="" width="48" height="48" />
          </div>
          <div className="eyebrow">ONE GATEWAY. EVERY POSSIBILITY.</div>
          <h2 id="closing-title">
            {t('مدل بعدی شما،')}
            <br />
            {t('فقط یک مسیر تازه است.')}
          </h2>
          <p>{t('زیرساختی بسازید که با انتخاب‌های شما رشد می‌کند.')}</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#integration">
              {t('اولین اتصال را بسازید')}
              <ArrowLeft size={17} />
            </a>
            <a
              className="button button-secondary"
              href={repository}
              target="_blank"
              rel="noreferrer"
            >
              <GitFork size={17} /> {t('مشاهدهٔ پروژه')}
            </a>
          </div>
        </section>
      </main>

      <footer className="footer container">
        <div className="footer-main">
          <div>
            <Brand footer />
            <p>{t('زیرساختی برای آزادی انتخاب.')}</p>
          </div>
          <div className="footer-links">
            <div>
              <h3>{t('کشف DiRouter')}</h3>
              <a href="#capabilities">{t('قابلیت‌ها')}</a>
              <a href="#routing">{t('دموی مسیریابی')}</a>
              <a href="#faq">{t('پرسش‌های متداول')}</a>
            </div>
            <div>
              <h3>{t('برای سازنده‌ها')}</h3>
              <a href="#integration">{t('شروع سریع')}</a>
              <a href={`${repository}/blob/main/DOCUMENTATION.md`} target="_blank" rel="noreferrer">
                {t('مستندات')}
                <ExternalLink size={11} />
              </a>
              <a href={repository} target="_blank" rel="noreferrer">
                GitHub <ExternalLink size={11} />
              </a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <span className="development-status">
            <span /> {t('پروژه در حال توسعه است')}
          </span>
          <span className="english">Designed to keep you connected.</span>
          <a href="#top">
            {t('بازگشت به بالا')}
            <ArrowUpLeft size={12} />
          </a>
        </div>
      </footer>
    </div>
  );
}
