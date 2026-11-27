/**
 * Filters above a list: a wrapping row of labelled Mantine inputs. `SearchInput` is a search box
 * (role searchbox) with the icon and the API's length cap; `SelectFilter` is a native select
 * (Mantine NativeSelect), so keyboard and screen-reader behaviour stay the browser's.
 */
import { Group, NativeSelect, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { MAX_SEARCH } from '../core/search/search';

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <Group className="filters" gap="sm" align="flex-end" wrap="wrap">
      {children}
    </Group>
  );
}

export function SearchInput({
  label,
  value,
  onChange,
  placeholder,
  maxLength = MAX_SEARCH,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <TextInput
      className="search-field"
      type="search"
      label={label}
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      leftSection={<IconSearch size={16} aria-hidden="true" />}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

export function SelectFilter<V extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: V;
  onChange: (value: V) => void;
  options: readonly (readonly [V, string])[];
  className?: string;
}) {
  return (
    <NativeSelect
      className={`select-field${className ? ` ${className}` : ''}`}
      label={label}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as V)}
      data={options.map(([v, l]) => ({ value: v, label: l }))}
    />
  );
}
