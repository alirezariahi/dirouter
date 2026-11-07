/**
 * اعتبارسنجی با zod و تولید اسکیمای OpenAPI از همان اسکیما (یک منبع حقیقت).
 */
import { ValidationError } from '@dirouter/shared';
import { applyDecorators, type PipeTransform } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiQuery } from '@nestjs/swagger';
import { z } from 'zod';

export function toOpenApi(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
  });
  delete json.$schema;
  return json;
}

export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(body)',
        message: issue.message,
      })),
    );
  }
}

/** مستندسازی بدنهٔ درخواست در Swagger. */
export const ApiZodBody = (schema: z.ZodType) => ApiBody({ schema: toOpenApi(schema) });

/** مستندسازی پاسخ موفق در Swagger. */
export const ApiZodOk = (schema: z.ZodType, description?: string) =>
  ApiOkResponse({ schema: toOpenApi(schema), ...(description ? { description } : {}) });

/** مستندسازی پارامترهای query در Swagger از روی یک z.object. */
export function ApiZodQuery(schema: z.ZodObject) {
  return applyDecorators(
    ...Object.entries(schema.shape).map(([name, field]) =>
      ApiQuery({
        name,
        required: !(field as z.ZodType).safeParse(undefined).success,
        schema: toOpenApi(field as z.ZodType),
      }),
    ),
  );
}
