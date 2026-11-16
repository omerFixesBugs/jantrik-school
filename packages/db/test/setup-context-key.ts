import {
  createPrismaClient,
  loadRequestContextKeyAsOwner,
  setRequestContextKeySource,
} from '../src/index.js';
import { OWNER_URL } from './env.js';

// Every test file signs its institute contexts with the test database's key (P1-J8), read once
// per file as the schema owner (the API reads it through the password-login login instead).
setRequestContextKeySource(async () => {
  const owner = createPrismaClient(OWNER_URL, { max: 1 });
  try {
    return await loadRequestContextKeyAsOwner(owner);
  } finally {
    await owner.$disconnect();
  }
});
