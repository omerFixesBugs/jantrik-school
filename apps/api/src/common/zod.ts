import {
  BadRequestException,
  Injectable,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { z } from 'zod';

/**
 * DTO class backed by a zod schema (from @jantrik/shared). The global ZodValidationPipe
 * validates any parameter whose type is such a class.
 *
 *   export class LoginDto extends zodDto(passwordLoginSchema) {}
 *   login(@Body() dto: LoginDto) { ... }
 */
export function zodDto<T extends z.ZodType>(schema: T) {
  abstract class ZodDto {
    static readonly schema = schema;
  }
  return ZodDto as unknown as { new (): z.output<T>; readonly schema: T };
}

function schemaOf(metatype: unknown): z.ZodType | undefined {
  const schema = (metatype as { schema?: unknown } | undefined)?.schema;
  return schema && typeof (schema as z.ZodType).safeParse === 'function'
    ? (schema as z.ZodType)
    : undefined;
}

/** Global pipe: validates zod-backed DTOs. Error responses list paths, never input values. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const schema = schemaOf(metadata.metatype);
    if (!schema) return value;
    const result = schema.safeParse(value ?? {});
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}
