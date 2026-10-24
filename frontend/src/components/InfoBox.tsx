import {
    cloneElement,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type HTMLAttributes,
    type ButtonHTMLAttributes,
    type Ref,
    type ReactElement,
    type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Info, AlertTriangle } from 'lucide-react';

interface InfoBoxProps {
    heading?: string;
    children: ReactNode;
    label?: string;
    warning?: boolean;
    control?: ReactElement<HTMLAttributes<HTMLElement>>;
    descriptionId?: string;
}

export function InfoBox({ heading, children, label, warning, control, descriptionId }: InfoBoxProps) {
    const generatedId = useId();
    const id = descriptionId ?? generatedId;
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState({ left: 8, top: 8 });
    const trigger = useRef<HTMLElement | null>(null);
    const box = useRef<HTMLDivElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cancelClose = () => clearTimeout(timer.current);
    const contains = (node: EventTarget | null) =>
        node instanceof Node && (trigger.current?.contains(node) || box.current?.contains(node));
    const closeSoon = () => {
        cancelClose();
        timer.current = setTimeout(() => {
            if (!contains(document.activeElement)) setOpen(false);
        }, 120);
    };
    useEffect(() => () => clearTimeout(timer.current), []);
    useEffect(() => {
        if (!open) return;
        const outside = (event: PointerEvent) => {
            if (!contains(event.target)) setOpen(false);
        };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        const focus = (event: FocusEvent) => {
            if (!contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('keydown', escape);
        document.addEventListener('focusin', focus);
        return () => {
            document.removeEventListener('pointerdown', outside);
            document.removeEventListener('keydown', escape);
            document.removeEventListener('focusin', focus);
        };
    }, [open]);
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const anchor = trigger.current?.getBoundingClientRect();
            const popup = box.current?.getBoundingClientRect();
            if (!anchor || !popup) return;
            const left = Math.max(8, Math.min(anchor.left, window.innerWidth - popup.width - 8));
            const below = anchor.bottom + 4;
            const top =
                below + popup.height <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - popup.height - 4);
            setPosition({ left, top });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
        if (box.current) observer?.observe(box.current);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
            observer?.disconnect();
        };
    }, [open]);
    const props: HTMLAttributes<HTMLElement> = {
        'aria-describedby': [control?.props['aria-describedby'], id].filter(Boolean).join(' '),
        ...(control?.props['aria-expanded'] === undefined ? { 'aria-expanded': open } : {}),
        ...(!control ? { 'aria-controls': id } : {}),
        onPointerEnter: (event) => {
            control?.props.onPointerEnter?.(event);
            trigger.current = event.currentTarget;
            cancelClose();
            setOpen(true);
        },
        onPointerLeave: (event) => {
            control?.props.onPointerLeave?.(event);
            closeSoon();
        },
        onMouseEnter: (event) => {
            control?.props.onMouseEnter?.(event);
            trigger.current = event.currentTarget;
            cancelClose();
            setOpen(true);
        },
        onMouseLeave: (event) => {
            control?.props.onMouseLeave?.(event);
            closeSoon();
        },
        onFocus: (event) => {
            control?.props.onFocus?.(event);
            trigger.current = event.currentTarget;
            cancelClose();
            setOpen(true);
        },
        onClick: (event) => {
            control?.props.onClick?.(event);
            if (control) setOpen(false);
        },
        onBlur: (event) => {
            control?.props.onBlur?.(event);
            if (!contains(event.relatedTarget)) setOpen(false);
        },
    };
    return (
        <>
            {control ? (
                cloneElement(control, props)
            ) : (
                <button
                    {...props}
                    type="button"
                    className={`info-box-trigger${warning ? ' is-warning' : ''}`}
                    aria-label={label ?? `${heading ?? 'More'} information`}
                    onClick={(event) => {
                        event.stopPropagation();
                        trigger.current = event.currentTarget;
                        cancelClose();
                        setOpen(true);
                    }}
                    onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Escape') setOpen(false);
                    }}
                >
                    {warning ? <AlertTriangle size={13} aria-hidden="true" /> : <Info size={14} aria-hidden="true" />}
                </button>
            )}
            {createPortal(
                <div
                    id={id}
                    ref={box}
                    role={open ? 'tooltip' : undefined}
                    className={`info-box${control ? ' is-hint' : ''}${open ? ' is-open' : ''}`}
                    style={open ? position : undefined}
                    onMouseEnter={cancelClose}
                    onMouseLeave={closeSoon}
                >
                    {heading && <strong>{heading}</strong>}
                    {children}
                </div>,
                document.body
            )}
        </>
    );
}

export function HintButton({
    hint,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { hint: ReactNode; ref?: Ref<HTMLButtonElement> }) {
    return <InfoBox control={<button {...props} />}>{hint}</InfoBox>;
}

export function Help({
    help,
    children,
    as: Tag = 'span',
    ...props
}: HTMLAttributes<HTMLElement> & { help: ReactNode; as?: 'span' | 'div' | 'td' }) {
    return (
        <Tag {...props}>
            {children}
            {help && <InfoBox heading="Details">{help}</InfoBox>}
        </Tag>
    );
}
