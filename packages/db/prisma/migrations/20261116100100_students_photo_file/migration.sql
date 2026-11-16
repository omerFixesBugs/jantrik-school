-- Sprint 1 P2: a student's photo is a stored file of kind STUDENT_PHOTO, referenced by a composite
-- key with the kind (fixed by a CHECK), so it can only be a photo of the student's own institute.
-- The old photo_url column was never written (always null) and goes.

-- AlterTable
ALTER TABLE "students" DROP COLUMN "photo_url",
ADD COLUMN     "photo_file_id" UUID,
ADD COLUMN     "photo_file_kind" "stored_file_kind" NOT NULL DEFAULT 'STUDENT_PHOTO';

ALTER TABLE students
  ADD CONSTRAINT students_photo_file_kind CHECK (photo_file_kind = 'STUDENT_PHOTO');

-- CreateIndex (also the foreign key's index: a file belongs to one student)
CREATE UNIQUE INDEX "students_tenant_id_photo_file_id_photo_file_kind_key" ON "students"("tenant_id", "photo_file_id", "photo_file_kind");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_photo_file_id_photo_file_kind_fkey" FOREIGN KEY ("tenant_id", "photo_file_id", "photo_file_kind") REFERENCES "stored_files"("tenant_id", "id", "kind") ON DELETE RESTRICT ON UPDATE RESTRICT;
