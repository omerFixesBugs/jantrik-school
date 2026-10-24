-- DropForeignKey
ALTER TABLE "section_subject_teachers" DROP CONSTRAINT "section_subject_teachers_tenant_id_section_id_class_level__fkey";

-- DropForeignKey
ALTER TABLE "section_subject_teachers" DROP CONSTRAINT "section_subject_teachers_tenant_id_subject_id_class_level__fkey";

-- DropForeignKey
ALTER TABLE "student_subject_choices" DROP CONSTRAINT "student_subject_choices_tenant_id_subject_id_fkey";

-- CreateIndex
CREATE INDEX "section_subject_teachers_tenant_id_subject_id_idx" ON "section_subject_teachers"("tenant_id", "subject_id");

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_tenant_id_section_id_class_level__fkey" FOREIGN KEY ("tenant_id", "section_id", "class_level_id") REFERENCES "sections"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_tenant_id_subject_id_class_level__fkey" FOREIGN KEY ("tenant_id", "subject_id", "class_level_id") REFERENCES "subjects"("tenant_id", "id", "class_level_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "student_subject_choices" ADD CONSTRAINT "student_subject_choices_tenant_id_subject_id_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "subjects"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ───── Step 10, A1 review (hand-written) ─────

-- rows * cols could overflow int4 before the CHECK sees it: bound each side first.
ALTER TABLE exam_rooms DROP CONSTRAINT IF EXISTS exam_rooms_size;
ALTER TABLE exam_rooms
  ADD CONSTRAINT exam_rooms_size CHECK (
    rows BETWEEN 1 AND 500 AND cols BETWEEN 1 AND 500 AND rows * cols <= 500
  );

-- A bad template name would otherwise only fail when an institute signs up (provisionTenant).
ALTER TABLE template_subject_components
  ADD CONSTRAINT template_subject_components_names CHECK (
    length(btrim(name_bn)) BETWEEN 1 AND 60 AND length(btrim(name_en)) BETWEEN 1 AND 60
  );
