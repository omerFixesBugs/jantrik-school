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
  admitCardsQuerySchema,
  allocateSeatsSchema,
  correctMarksSchema,
  markSheetQuerySchema,
  returnMarkSheetSchema,
  saveMarkSheetSchema,
  unlockMarkSheetSchema,
  type ExamSheetsGrid,
  type LockAllResult,
  type MarkSheetHistoryEntry,
  type MarkSheetView,
  type MySheet,
  type SaveMarkSheetResult,
  createExamSchema,
  examCandidatesQuerySchema,
  examClassSubjectsSchema,
  examClassesSchema,
  examSubjectSetupSchema,
  examsQuerySchema,
  syncCandidatesSchema,
  updateExamSchema,
  type AdmitCards,
  type CandidateSyncResult,
  type ExamCandidateView,
  type ExamDetail,
  type ExamListItem,
  type ExamSubjectView,
  type SeatPlan,
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
import { ExamAccessService } from './exam-access.service.js';
import { ExamRosterService } from './marks/exam-roster.service.js';
import { MarkSheetService } from './marks/mark-sheet.service.js';
import { SeatPlanService } from './seats/seat-plan.service.js';
import { ExamSetupService } from './setup/exam-setup.service.js';
import { ExamStaffService } from './setup/exam-staff.service.js';
import { ExamService } from './structure/exam.service.js';

class ExamSetupSubjectsQueryDto extends zodDto(examSetupSubjectsQuerySchema) {}
class SubjectMarksDto extends zodDto(subjectMarksSchema) {}
class GradingRulesDto extends zodDto(gradingRulesSchema) {}
class SectionSubjectTeachersDto extends zodDto(sectionSubjectTeachersSchema) {}
class SubjectChoicesDto extends zodDto(subjectChoicesSchema) {}
class ExamRoomDto extends zodDto(examRoomSchema) {}
class ExamsQueryDto extends zodDto(examsQuerySchema) {}
class CreateExamDto extends zodDto(createExamSchema) {}
class UpdateExamDto extends zodDto(updateExamSchema) {}
class ExamClassesDto extends zodDto(examClassesSchema) {}
class ExamClassSubjectsDto extends zodDto(examClassSubjectsSchema) {}
class ExamSubjectSetupDto extends zodDto(examSubjectSetupSchema) {}
class SyncCandidatesDto extends zodDto(syncCandidatesSchema) {}
class AllocateSeatsDto extends zodDto(allocateSeatsSchema) {}
class AdmitCardsQueryDto extends zodDto(admitCardsQuerySchema) {}
class ExamCandidatesQueryDto extends zodDto(examCandidatesQuerySchema) {}
class MarkSheetQueryDto extends zodDto(markSheetQuerySchema) {}
export class SaveMarkSheetDto extends zodDto(saveMarkSheetSchema) {}
class ReturnMarkSheetDto extends zodDto(returnMarkSheetSchema) {}
class UnlockMarkSheetDto extends zodDto(unlockMarkSheetSchema) {}
class CorrectMarksDto extends zodDto(correctMarksSchema) {}

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

/**
 * Marks entry: subject teachers for their own subject and section, OWNER/ADMIN for any (the
 * service checks the assignment).
 */
@Controller('exams')
@RequireModule('EXAMS')
@Roles('OWNER', 'ADMIN', 'TEACHER')
export class MarkSheetController {
  constructor(private readonly sheets: MarkSheetService) {}

  @Get('my-sheets')
  mySheets(): Promise<MySheet[]> {
    return this.sheets.mySheets();
  }

  @Get('sheets')
  sheet(@Query() query: MarkSheetQueryDto): Promise<MarkSheetView> {
    return this.sheets.sheet(query.examSubjectId, query.sectionId);
  }

  @Put('sheets')
  save(@Body() dto: SaveMarkSheetDto): Promise<SaveMarkSheetResult> {
    return this.sheets.save(dto);
  }
}

/** Marks, the office's side (OWNER/ADMIN): return, lock, unlock, corrections, history, overview. */
@Controller('exams')
@RequireModule('EXAMS')
@Roles('OWNER', 'ADMIN')
export class MarkSheetAdminController {
  constructor(private readonly sheets: MarkSheetService) {}

  @Post('sheets/:id/return')
  @HttpCode(200)
  returnSheet(@Id() id: string, @Body() dto: ReturnMarkSheetDto): Promise<MarkSheetView> {
    return this.sheets.returnSheet(id, dto.note);
  }

  @Post('sheets/:id/lock')
  @HttpCode(200)
  lock(@Id() id: string): Promise<MarkSheetView> {
    return this.sheets.lock(id);
  }

  @Post('sheets/:id/unlock')
  @HttpCode(200)
  unlock(@Id() id: string, @Body() dto: UnlockMarkSheetDto): Promise<MarkSheetView> {
    return this.sheets.unlock(id, dto.reason);
  }

  @Put('sheets/:id/corrections')
  correct(@Id() id: string, @Body() dto: CorrectMarksDto): Promise<MarkSheetView> {
    return this.sheets.correct(id, dto);
  }

  @Get('sheets/:id/history')
  history(@Id() id: string): Promise<MarkSheetHistoryEntry[]> {
    return this.sheets.history(id);
  }

  @Get(':id/sheets')
  grid(@Id() id: string): Promise<ExamSheetsGrid> {
    return this.sheets.grid(id);
  }

  @Post(':id/classes/:examClassId/lock-all')
  @HttpCode(200)
  lockAll(@Id() id: string, @Id('examClassId') examClassId: string): Promise<LockAllResult> {
    return this.sheets.lockAll(id, examClassId);
  }
}

/** Exams, read: staff (teachers see open and archived exams; the service decides). */
@Controller('exams')
@RequireModule('EXAMS')
@Roles('OWNER', 'ADMIN', 'TEACHER')
export class ExamsReadController {
  constructor(private readonly exams: ExamService) {}

  @Get()
  list(@Query() query: ExamsQueryDto): Promise<ExamListItem[]> {
    return this.exams.list(query.academicYearId);
  }

  @Get(':id')
  detail(@Id() id: string): Promise<ExamDetail> {
    return this.exams.detail(id);
  }
}

/** Exams, write (OWNER/ADMIN): setup, opening, rosters, seats and admit cards. */
@Controller('exams')
@RequireModule('EXAMS')
@Roles('OWNER', 'ADMIN')
export class ExamsAdminController {
  constructor(
    private readonly exams: ExamService,
    private readonly seats: SeatPlanService,
  ) {}

  @Post()
  create(@Body() dto: CreateExamDto): Promise<ExamDetail> {
    return this.exams.create(dto);
  }

  @Patch(':id')
  update(@Id() id: string, @Body() dto: UpdateExamDto): Promise<ExamDetail> {
    return this.exams.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Id() id: string): Promise<void> {
    await this.exams.remove(id);
  }

  @Put(':id/classes')
  setClasses(@Id() id: string, @Body() dto: ExamClassesDto): Promise<ExamDetail> {
    return this.exams.setClasses(id, dto.classLevelIds);
  }

  @Put(':id/classes/:examClassId/subjects')
  setClassSubjects(
    @Id() id: string,
    @Id('examClassId') examClassId: string,
    @Body() dto: ExamClassSubjectsDto,
  ): Promise<ExamDetail> {
    return this.exams.setClassSubjects(id, examClassId, dto.subjectIds);
  }

  @Put(':id/subjects/:examSubjectId')
  setSubject(
    @Id() id: string,
    @Id('examSubjectId') examSubjectId: string,
    @Body() dto: ExamSubjectSetupDto,
  ): Promise<ExamSubjectView> {
    return this.exams.setSubject(id, examSubjectId, dto);
  }

  @Post(':id/open')
  @HttpCode(200)
  open(@Id() id: string): Promise<ExamDetail> {
    return this.exams.open(id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Id() id: string): Promise<ExamDetail> {
    return this.exams.setArchived(id, true);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Id() id: string): Promise<ExamDetail> {
    return this.exams.setArchived(id, false);
  }

  @Get(':id/candidates')
  candidates(
    @Id() id: string,
    @Query() query: ExamCandidatesQueryDto,
  ): Promise<ExamCandidateView[]> {
    return this.exams.candidates(id, query.sectionId);
  }

  @Post(':id/candidates/sync')
  @HttpCode(200)
  sync(@Id() id: string, @Body() dto: SyncCandidatesDto): Promise<CandidateSyncResult> {
    return this.exams.syncCandidates(id, dto.dryRun);
  }

  @Get(':id/seats')
  seatPlan(@Id() id: string): Promise<SeatPlan> {
    return this.seats.plan(id);
  }

  @Post(':id/seats')
  @HttpCode(200)
  allocate(@Id() id: string, @Body() dto: AllocateSeatsDto): Promise<SeatPlan> {
    return this.seats.allocate(id, dto.roomIds);
  }

  @Delete(':id/seats')
  @HttpCode(204)
  async clearSeats(@Id() id: string): Promise<void> {
    await this.seats.clear(id);
  }

  @Get(':id/admit-cards')
  admitCards(@Id() id: string, @Query() query: AdmitCardsQueryDto): Promise<AdmitCards> {
    return this.seats.admitCards(id, query);
  }
}

@Module({
  // Static routes (exams/setup/…, rooms, grading, staff, my-sheets, sheets) are declared before
  // exams/:id so they are never taken for an exam id.
  controllers: [
    ExamSetupController,
    MarkSheetController,
    MarkSheetAdminController,
    ExamsReadController,
    ExamsAdminController,
  ],
  providers: [
    ExamSetupService,
    ExamStaffService,
    ExamAccessService,
    ExamService,
    SeatPlanService,
    ExamRosterService,
    MarkSheetService,
  ],
  // MarkSheetService: test-only routes (rollback checks) inject it.
  exports: [MarkSheetService],
})
export class ExamsModule {}
