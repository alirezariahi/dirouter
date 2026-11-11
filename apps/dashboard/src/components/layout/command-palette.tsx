/** command palette with ⌘K / Ctrl+K: navigate to pages and run quick actions. */
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { useTranslation } from 'react-i18next';

import { useSettings } from '../../settings';
import { NAV } from './nav';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const s = useSettings();
  const close = () => {
    onOpenChange(false);
  };
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label={t('topbar.search')}
      className="fixed inset-x-0 top-24 z-50 mx-auto w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      overlayClassName="fixed inset-0 z-40 bg-black/30"
    >
      <Command.Input
        placeholder={t('palette.placeholder')}
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="p-4 text-center text-sm text-muted">
          {t('palette.empty')}
        </Command.Empty>
        <Command.Group
          heading={t('palette.navigate')}
          className="text-xs text-muted [&_[cmdk-group-items]]:text-sm [&_[cmdk-group-items]]:text-fg"
        >
          {NAV.map((n) => (
            <Command.Item
              key={n.to}
              value={`${t(`nav.${n.key}`)} ${n.key}`}
              onSelect={() => {
                void navigate({ to: n.to });
                close();
              }}
              className="cursor-pointer rounded-md px-3 py-2 aria-selected:bg-border/60"
            >
              {t(`nav.${n.key}`)}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group
          heading={t('palette.actions')}
          className="text-xs text-muted [&_[cmdk-group-items]]:text-sm [&_[cmdk-group-items]]:text-fg"
        >
          <Command.Item
            onSelect={() => {
              s.setTheme(s.theme === 'dark' ? 'light' : 'dark');
              close();
            }}
            className="cursor-pointer rounded-md px-3 py-2 aria-selected:bg-border/60"
          >
            {t('palette.toggleTheme')}
          </Command.Item>
          <Command.Item
            onSelect={() => {
              s.setLang(s.lang === 'fa' ? 'en' : 'fa');
              close();
            }}
            className="cursor-pointer rounded-md px-3 py-2 aria-selected:bg-border/60"
          >
            {t('palette.toggleLanguage')}
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

export default CommandPalette;
