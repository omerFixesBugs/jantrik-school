import { BullModule } from '@nestjs/bullmq';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  applyPromotionSchema,
  createPromotionRunSchema,
  numberRollsSchema,
  promotionRowsSchema,
  promotionsQuerySchema,
  rollsPreviewQuerySchema,
  switchCheckQuerySchema,
  updatePromotionRunSchema,
  type PromotionApplyCheck,
  type PromotionRunDetail,
  type PromotionRunsOverview,
  type RollsPreview,
  type SwitchCheck,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { ExamsModule } from '../exams/exams.module.js';
import { PROMOTIONS_QUEUE, PromotionApplyService } from './promotion-apply.service.js';
import { PromotionProcessor } from './promotion.processor.js';
import { PromotionService } from './promotion.service.js';
import { RollNumberingService } from './roll-numbering.service.js';
import { SwitchCheckService } from './switch-check.service.js';

class PromotionsQueryDto extends zodDto(promotionsQuerySchema) {}
class CreateRunDto extends zodDto(createPromotionRunSchema) {}
class UpdateRunDto extends zodDto(updatePromotionRunSchema) {}
class RowsDto extends zodDto(promotionRowsSchema) {}
class ApplyDto extends zodDto(applyPromotionSchema) {}
class RollsQueryDto extends zodDto(rollsPreviewQuerySchema) {}
class NumberRollsDto extends zodDto(numberRollsSchema) {}
class SwitchCheckQueryDto extends zodDto(switchCheckQuerySchema) {}

const Id = () => Param('id', ParseUUIDPipe);

/**
 * Promotion and the new session (sprint 1 P5, docs/promotion.md): OWNER/ADMIN, CORE. Static
 * routes (rolls, switch-check) come before :id.
 */
@Controller('promotions')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class PromotionController {
  constructor(
    private readonly promotions: PromotionService,
    private readonly applying: PromotionApplyService,
    private readonly rolls: RollNumberingService,
    private readonly switching: SwitchCheckService,
  ) {}

  @Get()
  overview(@Query() q: PromotionsQueryDto): Promise<PromotionRunsOverview> {
    return this.promotions.overview(q.toYearId);
  }

  @Post()
  create(@Body() dto: CreateRunDto): Promise<PromotionRunDetail> {
    return this.promotions.create(dto);
  }

  @Get('rolls')
  rollsPreview(@Query() q: RollsQueryDto): Promise<RollsPreview> {
    return this.rolls.preview(q.toYearId, q.classLevelId);
  }

  @Put('rolls')
  numberRolls(@Body() dto: NumberRollsDto): Promise<RollsPreview> {
    return this.rolls.save(dto);
  }

  @Get('switch-check')
  switchCheck(@Query() q: SwitchCheckQueryDto): Promise<SwitchCheck> {
    return this.switching.check(q.toYearId);
  }

  @Get(':id')
  detail(@Id() id: string): Promise<PromotionRunDetail> {
    return this.promotions.detail(id);
  }

  @Patch(':id')
  update(@Id() id: string, @Body() dto: UpdateRunDto): Promise<PromotionRunDetail> {
    return this.promotions.update(id, dto);
  }

  @Put(':id/rows')
  editRows(@Id() id: string, @Body() dto: RowsDto): Promise<PromotionRunDetail> {
    return this.promotions.editRows(id, dto.rows);
  }

  @Post(':id/refresh')
  @HttpCode(200)
  refresh(@Id() id: string): Promise<PromotionRunDetail> {
    return this.promotions.refresh(id);
  }

  @Get(':id/apply-check')
  applyCheck(@Id() id: string): Promise<PromotionApplyCheck> {
    return this.applying.check(id);
  }

  @Post(':id/apply')
  @HttpCode(200)
  apply(@Id() id: string, @Body() dto: ApplyDto): Promise<PromotionRunDetail> {
    return this.applying.start(id, dto.version);
  }

  @Post(':id/resume')
  @HttpCode(200)
  resume(@Id() id: string): Promise<PromotionRunDetail> {
    return this.applying.resume(id);
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: PROMOTIONS_QUEUE }), ExamsModule],
  controllers: [PromotionController],
  providers: [
    PromotionService,
    PromotionApplyService,
    RollNumberingService,
    SwitchCheckService,
    PromotionProcessor,
  ],
  exports: [PromotionService, PromotionApplyService],
})
export class PromotionModule {}
