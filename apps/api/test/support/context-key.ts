import {
  createPrismaClient,
  loadRequestContextKeyAsOwner,
  setRequestContextKeySource,
} from '@jantrik/db';

// Fixtures written with withTenant / withContext before an app is booted (or next to the device
// receiver's harness, which has no LoginPrismaService) sign with the test database's key, read as
// the schema owner (P1-J8). A booted API replaces this source with its own: the password-login
// login, as in production.
setRequestContextKeySource(async () => {
  const owner = createPrismaClient(process.env['DATABASE_MIGRATION_URL_TEST']!, { max: 1 });
  try {
    return await loadRequestContextKeyAsOwner(owner);
  } finally {
    await owner.$disconnect();
  }
});
