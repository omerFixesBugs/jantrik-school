'use client';

import { useMutation } from '@tanstack/react-query';
import {
  DEVICE_DIRECTIONS,
  toAsciiDigits,
  type CreateDeviceInput,
  type DeviceDirection,
  type DeviceView,
  type UpdateDeviceInput,
} from '@jantrik/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { SelectField, TextField } from '@/components/form-kit';
import { FormDialog } from '@/components/setup/setup-kit';
import { ApiError } from '@/lib/api/errors';
import { useAuth } from '@/lib/auth/auth-provider';
import { useDevicesError, useInvalidateDevices } from './kit';

/** As the API reads it: ASCII digits, no spaces around, upper case. */
const normalSerial = (v: string) => toAsciiDigits(v).trim().toUpperCase();
const SERIAL_RE = /^[A-Z0-9]{6,32}$/;

type Form = { serialNo: string; name: string; gate: string; direction: DeviceDirection };

/**
 * Add a device (brand, serial number, name, gate, direction) or edit one. A device that has
 * connected keeps its serial number. Mounted per opening, so it starts from the device as it is.
 */
export function DeviceFormDialog({
  device,
  onOpenChange,
  onCreated,
}: {
  /** 'new' to add one. */
  device: DeviceView | 'new';
  onOpenChange: (open: boolean) => void;
  onCreated: (device: DeviceView) => void;
}) {
  const t = useTranslations('devices.devices.form');
  const tDir = useTranslations('devices.devices.direction');
  const message = useDevicesError();
  const invalidate = useInvalidateDevices();
  const { client } = useAuth();
  const editing = device === 'new' ? null : device;
  const serialLocked = editing !== null && editing.lastSeenAt !== null;
  const [form, setForm] = useState<Form>(() => ({
    serialNo: editing?.serialNo ?? '',
    name: editing?.name ?? '',
    gate: editing?.gate ?? '',
    direction: editing?.direction ?? 'BOTH',
  }));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const save = useMutation({
    mutationFn: async () => {
      const serialNo = normalSerial(form.serialNo);
      if (!editing) {
        const body: CreateDeviceInput = {
          brand: 'ZKTECO',
          serialNo,
          name: form.name.trim(),
          gate: form.gate.trim() || null,
          direction: form.direction,
        };
        return {
          created: true,
          device: await client.api<DeviceView>('/attendance/devices', {
            method: 'POST',
            json: body,
          }),
        };
      }
      // Only what changed is sent.
      const body: UpdateDeviceInput = {};
      if (form.name.trim() !== editing.name) body.name = form.name.trim();
      if ((form.gate.trim() || null) !== editing.gate) body.gate = form.gate.trim() || null;
      if (form.direction !== editing.direction) body.direction = form.direction;
      if (!serialLocked && serialNo !== editing.serialNo) body.serialNo = serialNo;
      return {
        created: false,
        device: await client.api<DeviceView>(`/attendance/devices/${editing.id}`, {
          method: 'PATCH',
          json: body,
        }),
      };
    },
    onSuccess: ({ created, device: saved }) => {
      invalidate();
      toast.success(created ? t('added', { name: saved.name }) : t('saved'));
      onOpenChange(false);
      if (created) onCreated(saved);
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'SERIAL_TAKEN' || e.code === 'SERIAL_LOCKED')) {
        setErrors({ serialNo: message(e) });
        return;
      }
      toast.error(message(e));
    },
  });

  const submit = () => {
    const next: typeof errors = {};
    if (!serialLocked && !SERIAL_RE.test(normalSerial(form.serialNo)))
      next.serialNo = t('serialInvalid');
    if (!form.name.trim()) next.name = t('nameRequired');
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };

  return (
    <FormDialog
      open
      onOpenChange={onOpenChange}
      title={editing ? t('editTitle', { name: editing.name }) : t('addTitle')}
      description={editing ? undefined : t('addDescription')}
      submitLabel={editing ? t('save') : t('add')}
      pending={save.isPending}
      onSubmit={submit}
      testId="device-form"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!editing && (
          <SelectField
            id="device-brand"
            label={t('brand')}
            value="ZKTECO"
            onChange={() => undefined}
            options={[{ value: 'ZKTECO', label: 'ZKTeco' }]}
            hint={t('brandHint')}
          />
        )}
        <TextField
          id="device-serial"
          label={t('serial')}
          value={form.serialNo}
          onChange={(v) => set('serialNo', v)}
          required={!serialLocked}
          disabled={serialLocked}
          hint={serialLocked ? t('serialLocked') : t('serialHint')}
          error={errors.serialNo}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          dir="ltr"
          data-testid="device-serial"
        />
        <TextField
          id="device-name"
          label={t('name')}
          value={form.name}
          onChange={(v) => set('name', v)}
          required
          hint={t('nameHint')}
          error={errors.name}
          maxLength={60}
          data-testid="device-name"
        />
        <TextField
          id="device-gate"
          label={t('gate')}
          value={form.gate}
          onChange={(v) => set('gate', v)}
          hint={t('gateHint')}
          maxLength={60}
        />
        <SelectField
          id="device-direction"
          label={t('direction')}
          value={form.direction}
          onChange={(v) => set('direction', v as DeviceDirection)}
          options={DEVICE_DIRECTIONS.map((d) => ({ value: d, label: tDir(d) }))}
          hint={t('directionHint')}
          className="sm:col-span-2"
        />
      </div>
    </FormDialog>
  );
}
