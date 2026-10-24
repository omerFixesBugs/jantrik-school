import { Injectable } from '@nestjs/common';

/** The current time. Inject it instead of calling `new Date()` so tests can move it. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
