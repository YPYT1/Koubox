import React from 'react'
import { FolderOpen } from '@phosphor-icons/react'
import { normalizeOsPath } from '@koubox/shared'
import { Button } from './Button'

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
    <div className={`form-group ${className}`}>
      <label>
        <span className="form-label-row">
          <span>{label}</span>
          {labelAction}
        </span>
        {optional && <span className="opt">{optional}</span>}
      </label>
      {children}
      {hint && <small className="field-hint">{hint}</small>}
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
  buttonIcon = <FolderOpen size={15} />
}: PathPickerProps) {
  return (
    <div className="path-picker-field">
      <input
        className="input-text"
        value={value}
        onChange={(e) => onChange(normalizeOsPath(e.target.value))}
        placeholder={placeholder}
        disabled={disabled}
      />
      <Button
        variant="secondary"
        size="md"
        type="button"
        icon={buttonIcon}
        onClick={onBrowse}
        disabled={disabled}
      >
        {buttonLabel}
      </Button>
    </div>
  )
}
