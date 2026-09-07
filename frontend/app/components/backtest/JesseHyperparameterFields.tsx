'use client';

import React from 'react';
import { defaultInputValue, type HyperparameterSpec } from '../../lib/jesseStrategy';

interface Props {
  specs: HyperparameterSpec[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onReset: () => void;
  disabled?: boolean;
}

/**
 * Editable hyperparameters for a Jesse-engine strategy.
 *
 * Renders one input per declared hyperparameter, typed from the spec: a
 * checkbox for `bool`, a stepped number input for `int` / `float` (bounded by
 * `min` / `max` when the strategy declares them), plain text otherwise. Fields
 * left at their defaults are not sent — see `collectHyperparameterOverrides`.
 */
export default function JesseHyperparameterFields({
  specs,
  values,
  errors,
  onChange,
  onReset,
  disabled = false,
}: Props) {
  if (specs.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-500" data-testid="jesse-no-hyperparameters">
        This strategy declares no hyperparameters.
      </p>
    );
  }

  const anyChanged = specs.some(
    (s) => (values[s.name] ?? defaultInputValue(s)) !== defaultInputValue(s)
  );

  return (
    <fieldset
      className="mt-4 border border-indigo-200 bg-indigo-50/40 rounded p-4"
      data-testid="jesse-hyperparameters"
      disabled={disabled}
    >
      <legend className="px-1 text-sm font-medium text-indigo-900 flex items-center gap-2">
        Hyperparameters
        <span className="text-xs font-normal text-indigo-700">Jesse engine</span>
      </legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {specs.map((spec) => {
          const id = `hp-${spec.name}`;
          const raw = values[spec.name] ?? defaultInputValue(spec);
          const error = errors[spec.name];
          const changed = raw !== defaultInputValue(spec);
          const bounds =
            spec.min != null || spec.max != null
              ? `${spec.min ?? '−∞'} … ${spec.max ?? '∞'}`
              : null;
          return (
            <div key={spec.name} className="block">
              <label
                htmlFor={id}
                className="text-xs font-medium text-gray-700 flex justify-between"
              >
                <span>
                  {spec.name}
                  <span className="ml-1 font-normal text-gray-400">{spec.type}</span>
                </span>
                {changed && <span className="text-indigo-600">edited</span>}
              </label>
              {spec.type === 'bool' ? (
                <input
                  id={id}
                  type="checkbox"
                  checked={['true', '1', 'yes', 'on'].includes(raw.toLowerCase())}
                  onChange={(e) => onChange(spec.name, e.target.checked ? 'true' : 'false')}
                  className="mt-2 h-4 w-4"
                />
              ) : (
                <input
                  id={id}
                  type={spec.type === 'int' || spec.type === 'float' ? 'number' : 'text'}
                  inputMode={spec.type === 'int' ? 'numeric' : 'decimal'}
                  step={spec.type === 'int' ? 1 : spec.type === 'float' ? 'any' : undefined}
                  min={spec.min ?? undefined}
                  max={spec.max ?? undefined}
                  value={raw}
                  onChange={(e) => onChange(spec.name, e.target.value)}
                  aria-invalid={Boolean(error)}
                  className={`mt-1 w-full border rounded px-2 py-1.5 text-sm ${
                    error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white'
                  }`}
                />
              )}
              <div className="mt-0.5 text-[11px] leading-4">
                {error ? (
                  <span className="text-red-600" role="alert">
                    {error}
                  </span>
                ) : (
                  <span className="text-gray-400">
                    default {defaultInputValue(spec) || '—'}
                    {bounds ? ` · ${bounds}` : ''}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {anyChanged && (
        <button
          type="button"
          onClick={onReset}
          className="mt-3 text-xs text-indigo-700 hover:text-indigo-900 underline"
        >
          Reset to defaults
        </button>
      )}
    </fieldset>
  );
}
