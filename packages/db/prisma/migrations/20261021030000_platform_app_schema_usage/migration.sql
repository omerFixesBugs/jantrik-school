-- Step 8, after the second review: jantrik_platform_app is no longer a member of jantrik_app
-- (docker/postgres/init/01-roles.sh; role membership is set up outside migrations). This replaces
-- the note in 20261021020000: the platform module's login may run the platform_* functions and
-- nothing else, so it can never read an institute's rows. Platform actions that change an
-- institute (provisioning, part 2) run through the API's main role in their own transaction.
--
-- Calling public.platform_*() needs USAGE on the schema (PUBLIC has none here).
GRANT USAGE ON SCHEMA public TO jantrik_platform_app;
