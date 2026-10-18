import { HttpException } from '@nestjs/common';

/** An error response with a machine-readable code: `{ statusCode, code, message, ...extra }`. */
export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpException {
  return new HttpException({ statusCode: status, code, message, ...extra }, status);
}
