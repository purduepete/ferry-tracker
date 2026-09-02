import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';

export interface FilterSelectOption<T extends string | number> {
  value: T;
  label: string;
  favorite?: boolean;
}

interface FilterSelectProps<T extends string | number> {
  ariaLabel: string;
  disabled?: boolean;
  options: Array<FilterSelectOption<T>>;
  placeholder?: string;
  value: T | null;
  onChange: (value: T) => void;
}

export function FilterSelect<T extends string | number>({ ariaLabel, disabled = false, options, placeholder = 'Select', value, onChange }: FilterSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    setHighlightIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };

  const select = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
      return;
    }

    if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (!options.length) return;

    let nextIndex = highlightIndex;
    if (event.key === 'ArrowDown') nextIndex = (highlightIndex + 1) % options.length;
    else if (event.key === 'ArrowUp') nextIndex = (highlightIndex - 1 + options.length) % options.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = options.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(highlightIndex);
      return;
    } else return;

    event.preventDefault();
    setHighlightIndex(nextIndex);
  };

  return (
    <div className="filter-select" ref={containerRef}>
      <button
        type="button"
        className="filter-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && highlightIndex >= 0 ? optionId(highlightIndex) : undefined}
        disabled={disabled}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown className={open ? 'open' : ''} size={15} />
      </button>
      {open && <div className="filter-select-menu" id={listboxId} role="listbox" aria-label={ariaLabel}>
        {options.map((option, index) => {
          const active = option.value === value;
          return <button
            key={option.value}
            id={optionId(index)}
            type="button"
            role="option"
            aria-selected={active}
            className={`filter-select-option${active ? ' selected' : ''}${highlightIndex === index ? ' highlighted' : ''}`}
            onPointerMove={() => setHighlightIndex(index)}
            onClick={() => select(index)}
          >
            <span className="option-check">{active && <Check size={14} />}</span>
            <span>{option.label}</span>
            <span className="option-favorite" aria-hidden="true">{option.favorite && <Star fill="currentColor" size={13} />}</span>
          </button>;
        })}
      </div>}
    </div>
  );
}