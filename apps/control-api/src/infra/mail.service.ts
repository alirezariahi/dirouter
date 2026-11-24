/**
 * Transactional email (card 24.2): invitations, email verification and alert channel tests go out
 * through the same SMTP mailer the worker uses for alerts (`SMTP_URL`, `SMTP_FROM`).
 */
import {
  createMailer,
  type MailMessage,
  type Mailer,
  type MailResult,
} from '@dirouter/shared/mail';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';

import { ENV, type Env } from '../env.js';

@Injectable()
export class MailService implements OnModuleDestroy {
  readonly mailer: Mailer;

  constructor(@Inject(ENV) env: Env) {
    this.mailer = createMailer({
      url: env.SMTP_URL,
      from: env.SMTP_FROM,
      production: env.NODE_ENV === 'production',
    });
  }

  get enabled(): boolean {
    return this.mailer.enabled;
  }

  send(message: MailMessage): Promise<MailResult> {
    return this.mailer.send(message);
  }

  onModuleDestroy(): void {
    this.mailer.close();
  }
}
