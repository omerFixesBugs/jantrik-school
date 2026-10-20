import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  nextOnboardingStep,
  onboardingStepSchema,
  onboardingStepsFor,
  onboardingStepUpdateSchema,
  type Onboarding,
  type OnboardingStates,
  type OnboardingStep,
  type OnboardingStepState,
} from '@jantrik/shared';
import { AuditService } from '../audit/audit.module.js';
import { apiError } from '../common/api-error.js';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { Db } from '../tenancy/db.service.js';

class StepUpdateDto extends zodDto(onboardingStepUpdateSchema) {}

interface ProgressRow {
  id: string;
  steps: OnboardingStates;
  completed_at: Date | null;
}

const NO_WIZARD: Onboarding = {
  wizard: false,
  steps: [],
  states: {},
  nextStep: null,
  completedAt: null,
};

/**
 * The new owner's setup wizard (step 8, part 5): which steps are done or skipped, saved per step.
 * Only institutes the platform created have a row (made at provisioning); without one there is no
 * wizard and the steps cannot be saved. The institute's own row, under RLS.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<Onboarding> {
    const [row] = await this.db.tx.$queryRaw<ProgressRow[]>`
      SELECT id, steps, completed_at FROM onboarding_progress`;
    return row ? this.view(row, await this.steps()) : NO_WIZARD;
  }

  /** Mark one step done or skipped (again: the latest answer wins). 409 once finished. */
  async setStep(step: OnboardingStep, state: OnboardingStepState): Promise<Onboarding> {
    const steps = await this.steps();
    if (!steps.includes(step)) {
      const exists = await this.db.tx.onboardingProgress.findFirst({ select: { id: true } });
      if (!exists) throw new NotFoundException('This institute has no setup wizard');
      throw apiError(422, 'ONBOARDING_STEP_UNAVAILABLE', 'This step does not apply here');
    }
    // One statement: two tabs saving different steps both keep their answer.
    const [row] = await this.db.tx.$queryRaw<ProgressRow[]>`
      UPDATE onboarding_progress
         SET steps = steps || jsonb_build_object(${step}::text, ${state}::text), updated_at = now()
       WHERE completed_at IS NULL
      RETURNING id, steps, completed_at`;
    if (!row) throw await this.notOpen();
    return this.view(row, steps);
  }

  /** Close the wizard: the steps not answered yet count as skipped. Finishing twice is fine. */
  async finish(): Promise<Onboarding> {
    const tx = this.db.tx;
    const [row] = await tx.$queryRaw<ProgressRow[]>`
      SELECT id, steps, completed_at FROM onboarding_progress FOR UPDATE`;
    if (!row) throw new NotFoundException('This institute has no setup wizard');
    const steps = await this.steps();
    if (row.completed_at) return this.view(row, steps);
    const states: OnboardingStates = { ...row.steps };
    for (const s of steps) states[s] ??= 'skipped';
    const [done] = await tx.$queryRaw<ProgressRow[]>`
      UPDATE onboarding_progress
         SET steps = ${JSON.stringify(states)}::jsonb, completed_at = now(), updated_at = now()
       WHERE id = ${row.id}::uuid
      RETURNING id, steps, completed_at`;
    await this.audit.record({
      entity: 'onboarding_progress',
      entityId: row.id,
      action: 'UPDATE',
      oldValues: { steps: row.steps, completed: false },
      newValues: { steps: states, completed: true },
    });
    return this.view(done!, steps);
  }

  private async steps(): Promise<OnboardingStep[]> {
    const modules = await this.db.tx.tenantModule.findMany({
      where: { enabled: true },
      select: { moduleKey: true },
    });
    return onboardingStepsFor(modules.map((m) => m.moduleKey));
  }

  private view(row: ProgressRow, steps: OnboardingStep[]): Onboarding {
    const states: OnboardingStates = {};
    for (const s of steps) if (row.steps[s]) states[s] = row.steps[s];
    return {
      wizard: true,
      steps,
      states,
      nextStep: row.completed_at ? null : nextOnboardingStep(steps, states),
      completedAt: row.completed_at?.toISOString() ?? null,
    };
  }

  private async notOpen() {
    const exists = await this.db.tx.onboardingProgress.findFirst({ select: { id: true } });
    return exists
      ? apiError(409, 'ONBOARDING_FINISHED', 'The setup wizard is already finished')
      : new NotFoundException('This institute has no setup wizard');
  }
}

/** The setup wizard (OWNER/ADMIN). */
@Controller('onboarding')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  get(): Promise<Onboarding> {
    return this.onboarding.get();
  }

  @Put('steps/:step')
  setStep(@Param('step') step: string, @Body() dto: StepUpdateDto): Promise<Onboarding> {
    const parsed = onboardingStepSchema.safeParse(step);
    if (!parsed.success) throw new NotFoundException('Unknown step');
    return this.onboarding.setStep(parsed.data, dto.state);
  }

  @Post('finish')
  @HttpCode(200)
  finish(): Promise<Onboarding> {
    return this.onboarding.finish();
  }
}
