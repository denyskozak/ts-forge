import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import {
  Badge as RadixBadge,
  Button as RadixButton,
  Card as RadixCard,
  Checkbox as RadixCheckbox,
  Dialog,
  IconButton as RadixIconButton,
  Select,
  Switch as RadixSwitch,
  Tabs,
  TextArea as RadixTextArea,
  TextField,
} from '@radix-ui/themes';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, X } from 'lucide-react';

export { Tabs };

const cosmeticClasses = new Set(['button', 'primary', 'text-button', 'icon-button', 'approve-button']);
const classes = (value = '') =>
  value.split(/\s+/).filter((name) => name && !cosmeticClasses.has(name)).join(' ') || undefined;

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <svg className={small ? 'forge-mark small' : 'forge-mark'} viewBox="0 0 40 44" fill="none" aria-hidden="true">
      <path d="M22 2 4 25h13L14 42l22-27H22l4-13h-4Z" fill="currentColor" />
      <path d="m18 24 8-9H15l-6 8h9Z" fill="#111214" opacity=".35" />
    </svg>
  );
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  const color = tone === 'green' ? 'green' : tone === 'amber' ? 'amber' : tone === 'red' ? 'red' : 'gray';
  return <RadixBadge color={color}>{children}</RadixBadge>;
}

export function Button({ children, primary = false, className = '', type = 'button', ...props }:
  ComponentPropsWithoutRef<typeof RadixButton> & { primary?: boolean }) {
  const ghost = /(?:^|\s)(?:text-button|icon-button)(?:\s|$)/.test(className);
  return (
    <RadixButton
      type={type}
      variant={primary ? 'solid' : ghost ? 'ghost' : props.variant ?? 'soft'}
      highContrast={primary || props.highContrast}
      className={classes(className)}
      {...props}
    >
      {children}
    </RadixButton>
  );
}

export function IconButton({ children, className = '', type = 'button', ...props }:
  ComponentPropsWithoutRef<typeof RadixIconButton>) {
  return (
    <RadixIconButton type={type} variant={props.variant ?? 'ghost'} className={classes(className)} {...props}>
      {children}
    </RadixIconButton>
  );
}

export function Card(props: ComponentPropsWithoutRef<typeof RadixCard>) {
  return <RadixCard {...props} />;
}

export function TextInput(props: ComponentPropsWithoutRef<typeof TextField.Root>) {
  return <TextField.Root {...props} />;
}

export const TextArea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<typeof RadixTextArea>>(
  function TextArea(props, ref) {
    return <RadixTextArea ref={ref} resize="vertical" {...props} />;
  },
);

export function Checkbox(props: ComponentPropsWithoutRef<typeof RadixCheckbox>) {
  return <RadixCheckbox {...props} />;
}

export function Switch(props: ComponentPropsWithoutRef<typeof RadixSwitch>) {
  return <RadixSwitch {...props} />;
}

export function SelectField({ value, onValueChange, options, ariaLabel, disabled }: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <Select.Trigger aria-label={ariaLabel} />
      <Select.Content position="popper">
        {options.map((option) => <Select.Item key={option.value} value={option.value}>{option.label}</Select.Item>)}
      </Select.Content>
    </Select.Root>
  );
}

export function Disclosure({ title, children, className, open, defaultOpen, onOpenChange }: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Collapsible.Root className={className} open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <Collapsible.Trigger asChild>
        <RadixButton variant="ghost" className="radix-disclosure-trigger">
          <span>{title}</span>
          <ChevronDown size={14} className="radix-disclosure-chevron" />
        </RadixButton>
      </Collapsible.Trigger>
      <Collapsible.Content className="radix-disclosure-content">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-header"><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Content maxWidth="760px">
        <div className="modal-header">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Close>
            <RadixIconButton variant="ghost" title="Close dialog" aria-label="Close dialog"><X size={19} /></RadixIconButton>
          </Dialog.Close>
        </div>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  );
}
