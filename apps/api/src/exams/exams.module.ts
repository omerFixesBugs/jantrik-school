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
  examRoomSchema,
  examSetupSubjectsQuerySchema,
  gradingRulesSchema,
  sectionSubjectTeachersSchema,
  subjectChoicesSchema,
  subjectMarksSchema,
  type ExamRoomView,
  type ExamSetupSubjects,
  type ExamStaffMember,
  type GradingSchemeView,
  type LoadTemplateMarksResult,
  type SectionSubjectTeachersView,
  type SubjectChoicesView,
  type SubjectMarksView,
} from '@jantrik/shared';
import { RequireModule, Roles } from '../common/decorators.js';
import { zodDto } from '../common/zod.js';
import { ExamSetupService } from './setup/exam-setup.service.js';
import { ExamStaffService } from './setup/exam-staff.service.js';

class ExamSetupSubjectsQueryDto extends zodDto(examSetupSubjectsQuerySchema) {}
class SubjectMarksDto extends zodDto(subjectMarksSchema) {}
class GradingRulesDto extends zodDto(gradingRulesSchema) {}
class SectionSubjectTeachersDto extends zodDto(sectionSubjectTeachersSchema) {}
class SubjectChoicesDto extends zodDto(subjectChoicesSchema) {}
class ExamRoomDto extends zodDto(examRoomSchema) {}

const Id = (name = 'id') => Param(name, ParseUUIDPipe);

/** Exams setup (docs/exams.md): subject marks, subject teachers, choices, rooms, grading. */
@Controller('exams')
@RequireModule('EXAMS')
@Roles('OWNER', 'ADMIN')
export class ExamSetupController {
  constructor(
    private readonly setup: ExamSetupService,
    private readonly staff: ExamStaffService,
  ) {}

  @Get('setup/subjects')
  subjects(@Query() query: ExamSetupSubjectsQueryDto): Promise<ExamSetupSubjects> {
    return this.setup.subjects(query.classLevelId);
  }

  @Put('setup/subjects/:id/marks')
  saveSubjectMarks(@Id() id: string, @Body() dto: SubjectMarksDto): Promise<SubjectMarksView> {
    return this.setup.saveSubjectMarks(id, dto);
  }

  @Post('setup/subjects/load-template')
  @HttpCode(200)
  loadTemplateMarks(): Promise<LoadTemplateMarksResult> {
    return this.setup.loadTemplateMarks();
  }

  @Get('setup/sections/:id/subject-teachers')
  subjectTeachers(@Id() id: string): Promise<SectionSubjectTeachersView> {
    return this.staff.subjectTeachers(id);
  }

  @Put('setup/sections/:id/subject-teachers')
  setSubjectTeachers(
    @Id() id: string,
    @Body() dto: SectionSubjectTeachersDto,
  ): Promise<SectionSubjectTeachersView> {
    return this.staff.setSubjectTeachers(id, dto);
  }

  @Get('setup/sections/:id/subject-choices')
  subjectChoices(@Id() id: string): Promise<SubjectChoicesView> {
    return this.staff.subjectChoices(id);
  }

  @Put('setup/sections/:id/subject-choices')
  setSubjectChoices(@Id() id: string, @Body() dto: SubjectChoicesDto): Promise<SubjectChoicesView> {
    return this.staff.setSubjectChoices(id, dto);
  }

  /** Staff who can be given subjects (/attendance/staff belongs to the ATTENDANCE module). */
  @Get('staff')
  staffList(): Promise<ExamStaffMember[]> {
    return this.staff.staff();
  }

  @Get('rooms')
  rooms(): Promise<ExamRoomView[]> {
    return this.setup.rooms();
  }

  @Post('rooms')
  createRoom(@Body() dto: ExamRoomDto): Promise<ExamRoomView> {
    return this.setup.createRoom(dto);
  }

  @Patch('rooms/:id')
  updateRoom(@Id() id: string, @Body() dto: ExamRoomDto): Promise<ExamRoomView> {
    return this.setup.updateRoom(id, dto);
  }

  @Delete('rooms/:id')
  @HttpCode(204)
  async deleteRoom(@Id() id: string): Promise<void> {
    await this.setup.deleteRoom(id);
  }

  @Get('grading')
  gradingSchemes(): Promise<GradingSchemeView[]> {
    return this.setup.gradingSchemes();
  }

  @Put('grading/:id')
  saveGradingRules(@Id() id: string, @Body() dto: GradingRulesDto): Promise<GradingSchemeView> {
    return this.setup.saveGradingRules(id, dto);
  }
}

@Module({
  controllers: [ExamSetupController],
  providers: [ExamSetupService, ExamStaffService],
})
export class ExamsModule {}
