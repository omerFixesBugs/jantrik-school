# Demo accounts (development only)

`pnpm db:seed` (or `pnpm db:reset`) creates these. **Never on a real database:** the seed
refuses `NODE_ENV=production`. Every password below is `Jantrik@2026`. OTP codes are printed in
the API log (`SMS_PROVIDER=console`).

## Institutes

| Who             | Phone         | Login           | Institute                                      |
| --------------- | ------------- | --------------- | ---------------------------------------------- |
| Owner           | `01711000001` | password or OTP | শাপলা উচ্চ বিদ্যালয় (Shapla High School)      |
| Teacher         | `01711000002` | password or OTP | Shapla, class teacher of ষষ্ঠ শ্রেণি ক         |
| Owner           | `01511000001` | password or OTP | আলো কোচিং সেন্টার (Alo Coaching Centre)        |
| Teacher at both | `01911000999` | password or OTP | Shapla and Alo (gets the institute picker)     |
| Guardian        | `01811000101` | OTP only        | father of two Shapla students (Tasnim, Tahmid) |
| Guardian        | `01811000102` | OTP only        | mother of Tasnim (Shapla)                      |

## Platform (Jantrik staff, `/platform`)

| Who            | Phone / email                            | Login                               |
| -------------- | ---------------------------------------- | ----------------------------------- |
| Platform admin | `01700000001` / `platform@jantrik.local` | password, then an authenticator app |

- The seeded platform admin has no authenticator yet. The first sign-in at `/platform/login`
  shows a QR code: scan it with any authenticator app (Google Authenticator, Microsoft
  Authenticator, Aegis…), type the code, and save the 10 backup codes shown once.
- The seed allows that set-up for 30 days. If the window has passed, run `pnpm db:seed` again
  (it reopens it while the admin is not set up).
- Lost the authenticator in development? Run
  `pnpm platform:admin reset-2fa --phone 01700000001 --reason "dev reset"` (after `pnpm build`),
  then sign in again.
- Real platform admins are created with `pnpm platform:admin` (see [platform.md](platform.md)).
