import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import JesseHyperparameterFields from '../app/components/backtest/JesseHyperparameterFields';
import { initialHyperparameterValues, type HyperparameterSpec } from '../app/lib/jesseStrategy';

const specs: HyperparameterSpec[] = [
  { name: 'fast', type: 'int', default: 10, min: 2, max: 100 },
  { name: 'risk_pct', type: 'float', default: 1.5, min: 0.1, max: 5 },
  { name: 'use_trail', type: 'bool', default: false },
];

describe('JesseHyperparameterFields', () => {
  it('renders one typed input per spec with its default and bounds', () => {
    render(
      <JesseHyperparameterFields
        specs={specs}
        values={initialHyperparameterValues(specs)}
        errors={{}}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(screen.getByTestId('jesse-hyperparameters')).toBeInTheDocument();

    const fast = screen.getByLabelText(/^fast/) as HTMLInputElement;
    expect(fast.type).toBe('number');
    expect(fast.value).toBe('10');
    expect(fast.min).toBe('2');
    expect(fast.max).toBe('100');
    expect(fast.step).toBe('1');

    const risk = screen.getByLabelText(/^risk_pct/) as HTMLInputElement;
    expect(risk.type).toBe('number');
    expect(risk.step).toBe('any');

    const trail = screen.getByLabelText(/^use_trail/) as HTMLInputElement;
    expect(trail.type).toBe('checkbox');
    expect(trail.checked).toBe(false);

    expect(screen.getByText(/default 10 · 2 … 100/)).toBeInTheDocument();
    expect(screen.queryByText('Reset to defaults')).toBeNull();
  });

  it('propagates edits, flags them and offers a reset', () => {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const values = { ...initialHyperparameterValues(specs), fast: '5' };
    render(
      <JesseHyperparameterFields
        specs={specs}
        values={values}
        errors={{}}
        onChange={onChange}
        onReset={onReset}
      />
    );

    fireEvent.change(screen.getByLabelText(/^fast/), { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith('fast', '7');

    fireEvent.click(screen.getByLabelText(/^use_trail/));
    expect(onChange).toHaveBeenCalledWith('use_trail', 'true');

    expect(screen.getByText('edited')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Reset to defaults'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows a field-level error in place of the default hint', () => {
    render(
      <JesseHyperparameterFields
        specs={specs}
        values={{ ...initialHyperparameterValues(specs), fast: '0' }}
        errors={{ fast: 'fast must be ≥ 2' }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('fast must be ≥ 2');
    expect((screen.getByLabelText(/^fast/) as HTMLInputElement).getAttribute('aria-invalid')).toBe(
      'true'
    );
  });

  it('explains when a strategy declares no hyperparameters', () => {
    render(
      <JesseHyperparameterFields
        specs={[]}
        values={{}}
        errors={{}}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />
    );
    expect(screen.getByTestId('jesse-no-hyperparameters')).toBeInTheDocument();
  });
});
