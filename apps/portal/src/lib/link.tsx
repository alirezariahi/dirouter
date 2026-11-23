/** In-app link: navigates with the history router, keeps modifier-clicks as normal links. */
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

import { navigate } from './router';

export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={go} {...rest} />;
}
