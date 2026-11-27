/**
 * Choose a driver for an RFID card (T161 point 2): search active drivers by name, email or phone
 * (GET /api/admin/v1/users, at least 2 characters, 300 ms after the last keystroke).
 */
import { Button, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import type { UserAccount } from '@powerme/shared';
import { useDriverSearchQuery } from '../../core/api/api';
import { rfidError } from './format';

export const DRIVER_SEARCH_DELAY_MS = 300;

export function DriverPicker({
  value,
  onChange,
  label = 'Tài xế',
}: {
  value: UserAccount | null;
  onChange: (driver: UserAccount | null) => void;
  label?: string;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DRIVER_SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);
  const skip = value !== null || [...q].length < 2;
  const { data, error, isFetching } = useDriverSearchQuery(q, { skip });

  if (value)
    return (
      <div className="field">
        {label}
        <div className="picked-driver">
          <span>
            <b>{value.full_name}</b>
            <span className="muted small">
              {' '}
              · {value.email}
              {value.phone_number && ` · ${value.phone_number}`}
            </span>
          </span>
          <Button type="button" size="compact-sm" variant="default" onClick={() => onChange(null)}>
            Đổi
          </Button>
        </div>
      </div>
    );
  return (
    <div>
      <TextInput
        label={label}
        type="search"
        value={text}
        maxLength={100}
        placeholder="Tên, email hoặc số điện thoại"
        leftSection={<IconSearch size={16} aria-hidden="true" />}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      {!skip &&
        (error ? (
          <p role="alert" className="form-error">
            {rfidError(error)}
          </p>
        ) : isFetching || !data ? (
          <Text size="sm" c="dimmed" mt={6}>
            Đang tìm…
          </Text>
        ) : data.items.length === 0 ? (
          <p className="muted small">Không có tài xế đang hoạt động nào khớp.</p>
        ) : (
          <ul className="driver-results" aria-label="Kết quả tìm tài xế">
            {data.items.map((d) => (
              <li key={d.id}>
                <Button
                  type="button"
                  variant="default"
                  justify="flex-start"
                  onClick={() => onChange(d)}
                >
                  <b>{d.full_name}</b>
                  <span className="muted small">
                    {' '}
                    · {d.email}
                    {d.phone_number && ` · ${d.phone_number}`}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
