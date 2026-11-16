-- Sprint 1 P2: a student's photo is a stored file (kind STUDENT_PHOTO), referenced by a composite
-- key so it can only be a file of the student's own institute. The old photo_url column was never
-- written (always null) and goes.

-- AlterTable
ALTER TABLE "students" DROP COLUMN "photo_url",
ADD COLUMN     "photo_file_id" UUID;

-- CreateIndex (also the foreign key's index: a file belongs to one student)
CREATE UNIQUE INDEX "students_tenant_id_photo_file_id_key" ON "students"("tenant_id", "photo_file_id");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_photo_file_id_fkey" FOREIGN KEY ("tenant_id", "photo_file_id") REFERENCES "stored_files"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
