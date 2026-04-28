// Compact stepper for indexer request-timeout fields. Mirrors the wait-time
// stepper style used by Ultimate Fallback: circular −/+ buttons
// with hold-to-accelerate, large bold value, and a Reset-to-default link that
// only appears when the current value differs from the default.

import type { PointerEventHandler } from 'react';

interface HoldRepeatProps {
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onPointerUp: PointerEventHandler<HTMLButtonElement>;
  onPointerLeave: PointerEventHandler<HTMLButtonElement>;
  onPointerCancel: PointerEventHandler<HTMLButtonElement>;
}

interface TimeoutStepperProps {
  value: number;
  defaultValue: number;
  min?: number;
  max?: number;
  decProps: HoldRepeatProps;
  incProps: HoldRepeatProps;
  onChange: (next: number) => void;
  inputId?: string;
}

export function TimeoutStepper({
  value,
  defaultValue,
  min = 1,
  max = 45,
  decProps,
  incProps,
  onChange,
  inputId,
}: TimeoutStepperProps) {
  const isDefault = value === defaultValue;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="inline-flex items-center gap-2 rounded-lg bg-slate-800/40 border border-slate-700/30 px-3 py-2">
        <button
          type="button"
          aria-label="Decrease timeout"
          {...decProps}
          className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
        >−</button>
        <div className="flex flex-col items-center">
          <input
            type="number"
            id={inputId}
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={value}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
            }}
            className="w-14 bg-transparent text-center text-2xl font-bold text-slate-100 focus:outline-none focus:text-primary-300 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none leading-none"
          />
          <span className="text-[10px] text-slate-500 font-medium tracking-wider uppercase mt-0.5">seconds</span>
        </div>
        <button
          type="button"
          aria-label="Increase timeout"
          {...incProps}
          className="w-7 h-7 rounded-full bg-slate-700/60 border border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-600/80 hover:border-slate-500/60 active:scale-90 transition-all text-sm font-medium flex items-center justify-center select-none"
        >+</button>
      </div>
      {!isDefault && (
        <button
          type="button"
          onClick={() => onChange(defaultValue)}
          className="text-[10px] text-primary-400/70 hover:text-primary-300 transition-colors pl-1"
        >
          Reset to default
        </button>
      )}
    </div>
  );
}
