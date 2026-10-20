import {
  Body,
  Controller,
  Delete,
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
  createAcademicYearSchema,
  createClassLevelSchema,
  createSectionSchema,
  createShiftSchema,
  createStudyGroupSchema,
  createSubjectSchema,
  sectionsQuerySchema,
  subjectsQuerySchema,
  updateAcademicYearSchema,
  updateClassLevelSchema,
  updateLabelsSchema,
  updateSectionSchema,
  updateShiftSchema,
  updateStudyGroupSchema,
  updateSubjectSchema,
  type SetupAcademicYear,
  type SetupClassLevel,
  type SetupLabel,
  type SetupSection,
  type SetupShift,
  type SetupStudyGroup,
  type SetupSubject,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { OnboardingController, OnboardingService } from './onboarding.js';
import { SetupService } from './setup.service.js';

class CreateAcademicYearDto extends zodDto(createAcademicYearSchema) {}
class UpdateAcademicYearDto extends zodDto(updateAcademicYearSchema) {}
class CreateClassLevelDto extends zodDto(createClassLevelSchema) {}
class UpdateClassLevelDto extends zodDto(updateClassLevelSchema) {}
class CreateStudyGroupDto extends zodDto(createStudyGroupSchema) {}
class UpdateStudyGroupDto extends zodDto(updateStudyGroupSchema) {}
class CreateShiftDto extends zodDto(createShiftSchema) {}
class UpdateShiftDto extends zodDto(updateShiftSchema) {}
class CreateSectionDto extends zodDto(createSectionSchema) {}
class UpdateSectionDto extends zodDto(updateSectionSchema) {}
class SectionsQueryDto extends zodDto(sectionsQuerySchema) {}
class CreateSubjectDto extends zodDto(createSubjectSchema) {}
class UpdateSubjectDto extends zodDto(updateSubjectSchema) {}
class SubjectsQueryDto extends zodDto(subjectsQuerySchema) {}
class UpdateLabelsDto extends zodDto(updateLabelsSchema) {}

const Id = () => Param('id', ParseUUIDPipe);

/** Institute setup: academic structure and labels (OWNER/ADMIN). */
@Controller('setup')
@RequireModule('CORE')
@Roles('OWNER', 'ADMIN')
export class SetupController {
  constructor(private readonly setup: SetupService) {}

  // Academic years
  @Get('academic-years')
  years(): Promise<SetupAcademicYear[]> {
    return this.setup.listYears();
  }

  @Post('academic-years')
  createYear(@Body() dto: CreateAcademicYearDto): Promise<SetupAcademicYear> {
    return this.setup.createYear(dto);
  }

  @Put('academic-years/:id')
  updateYear(@Id() id: string, @Body() dto: UpdateAcademicYearDto): Promise<SetupAcademicYear> {
    return this.setup.updateYear(id, dto);
  }

  @Post('academic-years/:id/current')
  @HttpCode(200)
  setCurrentYear(@Id() id: string): Promise<SetupAcademicYear> {
    return this.setup.setCurrentYear(id);
  }

  @Delete('academic-years/:id')
  @HttpCode(204)
  async deleteYear(@Id() id: string): Promise<void> {
    await this.setup.deleteYear(id);
  }

  // Class levels
  @Get('class-levels')
  classLevels(): Promise<SetupClassLevel[]> {
    return this.setup.listClassLevels();
  }

  @Post('class-levels')
  createClassLevel(@Body() dto: CreateClassLevelDto): Promise<SetupClassLevel> {
    return this.setup.createClassLevel(dto);
  }

  @Patch('class-levels/:id')
  updateClassLevel(@Id() id: string, @Body() dto: UpdateClassLevelDto): Promise<SetupClassLevel> {
    return this.setup.updateClassLevel(id, dto);
  }

  @Delete('class-levels/:id')
  @HttpCode(204)
  async deleteClassLevel(@Id() id: string): Promise<void> {
    await this.setup.deleteClassLevel(id);
  }

  // Study groups
  @Get('study-groups')
  studyGroups(): Promise<SetupStudyGroup[]> {
    return this.setup.listStudyGroups();
  }

  @Post('study-groups')
  createStudyGroup(@Body() dto: CreateStudyGroupDto): Promise<SetupStudyGroup> {
    return this.setup.createStudyGroup(dto);
  }

  @Patch('study-groups/:id')
  updateStudyGroup(@Id() id: string, @Body() dto: UpdateStudyGroupDto): Promise<SetupStudyGroup> {
    return this.setup.updateStudyGroup(id, dto);
  }

  @Delete('study-groups/:id')
  @HttpCode(204)
  async deleteStudyGroup(@Id() id: string): Promise<void> {
    await this.setup.deleteStudyGroup(id);
  }

  // Shifts
  @Get('shifts')
  shifts(): Promise<SetupShift[]> {
    return this.setup.listShifts();
  }

  @Post('shifts')
  createShift(@Body() dto: CreateShiftDto): Promise<SetupShift> {
    return this.setup.createShift(dto);
  }

  @Patch('shifts/:id')
  updateShift(@Id() id: string, @Body() dto: UpdateShiftDto): Promise<SetupShift> {
    return this.setup.updateShift(id, dto);
  }

  @Delete('shifts/:id')
  @HttpCode(204)
  async deleteShift(@Id() id: string): Promise<void> {
    await this.setup.deleteShift(id);
  }

  // Sections
  @Get('sections')
  sections(@Query() query: SectionsQueryDto): Promise<SetupSection[]> {
    return this.setup.listSections(query.academicYearId);
  }

  @Post('sections')
  createSection(@Body() dto: CreateSectionDto): Promise<SetupSection> {
    return this.setup.createSection(dto);
  }

  @Patch('sections/:id')
  updateSection(@Id() id: string, @Body() dto: UpdateSectionDto): Promise<SetupSection> {
    return this.setup.updateSection(id, dto);
  }

  @Delete('sections/:id')
  @HttpCode(204)
  async deleteSection(@Id() id: string): Promise<void> {
    await this.setup.deleteSection(id);
  }

  // Subjects
  @Get('subjects')
  subjects(@Query() query: SubjectsQueryDto): Promise<SetupSubject[]> {
    return this.setup.listSubjects(query.classLevelId);
  }

  @Post('subjects')
  createSubject(@Body() dto: CreateSubjectDto): Promise<SetupSubject> {
    return this.setup.createSubject(dto);
  }

  @Patch('subjects/:id')
  updateSubject(@Id() id: string, @Body() dto: UpdateSubjectDto): Promise<SetupSubject> {
    return this.setup.updateSubject(id, dto);
  }

  @Delete('subjects/:id')
  @HttpCode(204)
  async deleteSubject(@Id() id: string): Promise<void> {
    await this.setup.deleteSubject(id);
  }

  // Labels
  @Get('labels')
  labels(): Promise<SetupLabel[]> {
    return this.setup.listLabels();
  }

  @Put('labels')
  updateLabels(@Body() dto: UpdateLabelsDto): Promise<SetupLabel[]> {
    return this.setup.updateLabels(dto.labels);
  }
}

@Module({
  controllers: [SetupController, OnboardingController],
  providers: [SetupService, OnboardingService],
  exports: [SetupService],
})
export class SetupModule {}
