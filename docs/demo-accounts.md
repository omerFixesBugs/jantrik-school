# Demo accounts (development only)

`pnpm db:seed` (or `pnpm db:reset`) creates these. **Never on a real database:** the seed
refuses `NODE_ENV=production`. Every password below is `Jantrik@2026`. OTP codes are printed in
the API log (`SMS_PROVIDER=console`).

## Institutes

| Who             | Phone         | Login           | Institute                                                                         |
| --------------- | ------------- | --------------- | --------------------------------------------------------------------------------- |
| Owner           | `01711000001` | password or OTP | শাপলা উচ্চ বিদ্যালয় (Shapla High School)                                         |
| Teacher         | `01711000002` | password or OTP | Shapla, class teacher of ষষ্ঠ শ্রেণি ক, also collects fees (TEACHER + ACCOUNTANT) |
| Admin           | `01711000003` | password or OTP | Shapla (setup, voids, reminders)                                                  |
| Accountant      | `01711000004` | password or OTP | Shapla (fee counter, closing, bKash/Nagad)                                        |
| Owner           | `01511000001` | password or OTP | আলো কোচিং সেন্টার (Alo Coaching Centre)                                           |
| Teacher at both | `01911000999` | password or OTP | Shapla and Alo (gets the institute picker)                                        |
| Guardian        | `01811000101` | OTP only        | father of two Shapla students (Tasnim, Tahmid)                                    |
| Guardian        | `01811000102` | OTP only        | mother of Tasnim (Shapla)                                                         |

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

## Fees (Shapla)

The seed sets up fees for Shapla: admission, monthly tuition (৳10 a day late, at most ৳100),
two exam terms and a session fee; amounts for classes 6 and 9 (science group: its own tuition);
dues from the month two months before the seed date (within 2026); a 50 % sibling rule on
tuition (Tasnim and Tahmid are **suggested**, not confirmed: confirm them under Fees → Setup →
Siblings); a half free studentship for Arpita; bKash `01711000901` and Nagad `01711000902` as the
institute's numbers. Dues appear when a student's fees are first opened (or after the nightly
run). Demo students count as admitted on 1 January 2026 (the start of the demo year), so
they owe from the start month and no admission fee; a student admitted now pays it. Alo has FEES switched on but nothing set up (the empty states).

## Exams (step 10)

- **Shapla:** Nasrin (`01711000002`) enters Bangla and Maths in ষষ্ঠ শ্রেণি ক; Sharmin
  (`01911000999`) every subject of নবম শ্রেণি ক. Tahmid takes Biology as compulsory and Higher Maths
  as his 4th subject. Two rooms, কক্ষ ১০১ and কক্ষ ১০২.
  - **Half-yearly exam 2026** (June, classes 6 and 9): published, with a part failed, an absent
    paper, a 5.00 reached with the 4th-subject bonus, a Bangla pass that holds only under the
    combined rule, a merit tie broken by total marks, and Tasnim's remark. Guardians see it.
  - **Annual exam 2026** (November): open, every sheet locked except **6 ক Bangla** (Nasrin) and
    **9 ক English** (Sharmin), left empty to try marks entry; seated in both rooms.
- **Alo:** Maths and Physics have parts (MCQ 25 + written 25); **Model test 1** is published in
  marks mode, with Sakib and Nusrat tied on marks (the lower roll takes the higher place).

## Devices (step 11)

- **Shapla** has two ZKTeco devices, both in and out (BOTH): **প্রধান ফটক** (serial
  `DEMO00000001`) and **শিক্ষকদের কক্ষ** (`DEMO00000002`). They are registered when the seed runs
  and have never connected, so the first address that connects within 24 hours (the simulator on
  this PC) is trusted by itself. Later than that, trust it once on the Devices page (the setup
  guide asks "Is this your institute's internet connection?"); until then no commands reach the
  device.
- **Device IDs** for everyone: each student gets the digits of their code (`SHS-2026-0001` →
  `20260001`; ষষ্ঠ শ্রেণি ক rolls 2–27 are `20260102`–`20260127`), and the staff get numbers from
  9001 in the order they were added: Abdul Karim `9001`, Nasrin `9002`, Rafiqul `9003`, Shahana
  `9004`, Sharmin `9005`. Nothing is on the devices yet (People and device IDs → Send to
  devices).
- **A month of staff attendance:** in and out punches at শিক্ষকদের কক্ষ for the working days of
  the 30 days before the seed date, judged by the office hours 08:00–16:00 (10 minutes' grace
  each way). Some days are late (in after 08:10); Nasrin and Rafiqul each leave early once (3rd
  and 12th working day back); Sharmin has a sick leave entered by Rafiqul (অসুস্থতার ছুটি, 8th);
  Shahana did not punch on the 4th (absent). With the e2e date 2026-10-21 those are 18 Oct,
  7 Oct, 12 Oct and 17 Oct. Abdul Karim's attendance is not kept (an owner's, by default). Staff
  count from the first day of that month, so the staff report shows earlier days empty.
- No student punches and no device registers: **auto-mark and the entry/exit SMS are off**, so
  today's registers are still taken by hand.
- **Alo** has no devices (the empty states).

Playing with the simulator in development: run `pnpm dev` (the receiver listens on port 4080),
then in a second terminal `pnpm device:sim listen --sn DEMO00000001` (the device connects, gets
trusted and polls for commands every 30 s; `--interval 5` polls faster; Ctrl+C stops it), and in
a third send a morning of arrivals for ষষ্ঠ শ্রেণি ক:

```sh
pnpm device:sim morning --sn DEMO00000001 --pins 20260102-20260127 --from 07:30 --minutes 40
```

One staff punch: `pnpm device:sim punch --sn DEMO00000002 --pin 9002` (add `--out` for an out
punch, `--at 16:05` for a time). `pnpm device:sim --help` lists every command.

**Watching the device close a register.** Switching auto-mark on is not enough on its own: with
auto-mark on, the device closes a section's register only once **every active student of that
section has an ID confirmed on a device**. Until then the today page shows it held back as not
on a device (`NOT_ON_DEVICE`), with the count. After a seed nothing is on the devices, so:

1. Keep `pnpm device:sim listen --sn DEMO00000001` running.
2. On the Devices page, **Send people to this device** for প্রধান ফটক and wait until its pending
   count is 0 (the simulator prints "Users on device"; it takes 20 names per poll). One device is
   enough. The People page's "Send to devices" sends to শিক্ষকদের কক্ষ too, which never connects,
   so that list keeps showing "Sending".
3. Send the morning's arrivals (above). More than half of the section's active students must have
   punched in, and the device must have called in within 15 minutes (`listen` does that).
4. Switch auto-mark on in the attendance settings, and set the cutoff minutes so the cutoff of
   ষষ্ঠ শ্রেণি ক (morning shift, starts 07:00; cutoff 08:00 by default) falls a few minutes from
   now. It can be at most 300 minutes after the start (12:00).

The register is written within a minute of the cutoff; with the absent SMS switched on, they show
in the `pnpm dev` console after the correction delay. The device closes a register by itself only
until an hour after the cutoff (13:00 at the latest for this section); later, or while it is held
back, an owner or admin can **Take from the device** on the today page.
