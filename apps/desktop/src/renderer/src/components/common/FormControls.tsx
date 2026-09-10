import React from 'react'
import { FolderOpen } from 'lucide-react'
import { normalizeOsPath } from '@koubox/shared'
import { Button } from './Button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface FormFieldProps {
  label: string
  optional?: string
  hint?: string
  labelAction?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function FormField({ label, optional, hint, labelAction, children, className = '' }: FormFieldProps) {
  return (
    <div className={cn('grid gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-semibold text-foreground">
          {label}
          {optional ? <span className="ml-1 font-normal text-muted-foreground">{optional}</span> : null}
        </Label>
        {labelAction}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export interface PathPickerProps {
  value: string
  onChange: (val: string) => void
  onBrowse: () => Promise<void> | void
  placeholder?: string
  disabled?: boolean
  buttonLabel?: string
  buttonIcon?: React.ReactNode
}

export function PathPicker({
  value,
  onChange,
  onBrowse,
  placeholder,
  disabled = false,
  buttonLabel = '浏览',
  buttonIcon = <FolderOpen size={15} strokeWidth={1.8} />
}: PathPickerProps) {
  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(normalizeOsPath(e.target.value))}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1"
      />
      <Button variant="secondary" size="md" type="button" icon={buttonIcon} onClick={onBrowse} disabled={disabled}>
        {buttonLabel}
      </Button>
    </div>
  )
}
