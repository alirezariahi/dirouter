/** SCIM schema URNs and errors (RFC 7644 §3.12). */
import { DiRouterError } from '@dirouter/shared';

export const SCHEMAS = {
  user: 'urn:ietf:params:scim:schemas:core:2.0:User',
  group: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  list: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  patch: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  error: 'urn:ietf:params:scim:api:messages:2.0:Error',
} as const;

export class ScimError extends DiRouterError {
  constructor(
    status: 400 | 404 | 409,
    detail: string,
    readonly scimType?: string,
  ) {
    super(status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'invalid_request', {
      message: detail,
      status,
    });
  }
}
