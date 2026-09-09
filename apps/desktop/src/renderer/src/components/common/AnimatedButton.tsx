import type { ButtonProps } from './Button'
import { Button } from './Button'
import { showClickSpark } from './ClickSpark'

export function AnimatedButton(props: ButtonProps) {
  const { onClick, ...rest } = props
  return <Button {...rest} className={`animated-button ${props.className ?? ''}`} onClick={(event) => { showClickSpark(event); onClick?.(event) }} />
}
